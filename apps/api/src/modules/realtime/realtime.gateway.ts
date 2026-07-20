import { Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { TokenService, type AccessTokenPayload } from '../auth/token.service';

/**
 * Live updates for the kitchen (and any screen that wants them).
 *
 * The single most important rule here, and the one real products skip:
 * a socket is a SEPARATE connection with SEPARATE authorization. The HTTP
 * guards do not apply to it. So this gateway verifies the JWT itself on
 * connect, and puts each client into exactly ONE room — its own tenant's,
 * taken from the verified token, never from anything the client sends.
 *
 * A global broadcast, or a room name accepted from the client, would leak one
 * restaurant's live order feed to every other restaurant. Per-tenant rooms are
 * the whole point.
 */
@WebSocketGateway({
  // Same-origin in dev is cross-port; the allowlist mirrors the HTTP CORS.
  cors: { origin: true, credentials: true },
})
export class RealtimeGateway
  implements OnGatewayConnection, OnGatewayDisconnect, OnModuleInit
{
  private readonly logger = new Logger(RealtimeGateway.name);

  /** Live sockets per user, so a revoked session's connections can be dropped. */
  private readonly socketsByUser = new Map<string, Set<Socket>>();

  @WebSocketServer()
  private server!: Server;

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly tokens: TokenService,
  ) {}

  onModuleInit() {
    // A socket is authorised once, at connect. Without this it would keep
    // streaming the tenant's orders after "sign out everywhere" or after the
    // employee was deactivated, for as long as the tab stayed open.
    this.tokens.onSessionsRevoked((userId) => this.disconnectUser(userId));
  }

  /** Drops every live socket belonging to a user whose sessions were revoked. */
  private disconnectUser(userId: string) {
    const sockets = this.socketsByUser.get(userId);
    if (!sockets?.size) return;
    this.logger.debug(`revoking ${sockets.size} socket(s) for user ${userId}`);
    for (const socket of [...sockets]) socket.disconnect(true);
    this.socketsByUser.delete(userId);
  }

  handleDisconnect(client: Socket) {
    // socket.io types `data` as any; narrow once rather than spread casts.
    const { userId } = client.data as { userId?: string };
    if (!userId) return;
    const sockets = this.socketsByUser.get(userId);
    sockets?.delete(client);
    if (sockets && sockets.size === 0) this.socketsByUser.delete(userId);
  }

  async handleConnection(client: Socket) {
    // The access token is passed in the handshake auth payload, never a query
    // string (which lands in server logs and proxies).
    const token =
      (client.handshake.auth?.token as string | undefined) ??
      this.bearer(client.handshake.headers.authorization);

    if (!token) {
      client.disconnect(true);
      return;
    }

    let payload: AccessTokenPayload;
    try {
      payload = await this.jwt.verifyAsync<AccessTokenPayload>(token, {
        issuer: 'oraos',
        audience: 'oraos-api',
        algorithms: ['HS256'],
      });
    } catch {
      // Never say why — expired vs forged is free information.
      client.disconnect(true);
      return;
    }

    // A refresh token must not open a socket, same as it cannot call the API.
    if (payload.typ !== 'access' || !payload.rid) {
      client.disconnect(true);
      return;
    }

    // A token that predates a "sign out everywhere" (or a deactivation) must
    // not buy a fresh connection either — otherwise dropping the socket would
    // only last until the client reconnected.
    try {
      await this.tokens.assertAccessTokenNotStale(payload.sub, payload.iat);
    } catch {
      client.disconnect(true);
      return;
    }

    // The ONLY room this client may ever be in. The tenant comes from the
    // verified token; the client cannot choose it.
    await client.join(this.room(payload.rid));

    // Tracked so the connection can be dropped if the session is revoked.
    (client.data as { userId?: string }).userId = payload.sub;
    const existing = this.socketsByUser.get(payload.sub);
    if (existing) existing.add(client);
    else this.socketsByUser.set(payload.sub, new Set([client]));

    this.logger.debug(`socket ${client.id} joined restaurant:${payload.rid}`);
  }

  /**
   * Emits an event to one tenant's room. Called by services AFTER their
   * transaction commits — emitting inside a transaction that might roll back
   * would announce an order that never existed.
   */
  emitToTenant(restaurantId: string, event: string, payload: unknown) {
    this.server.to(this.room(restaurantId)).emit(event, payload);
  }

  private room(restaurantId: string) {
    return `restaurant:${restaurantId}`;
  }

  private bearer(header?: string): string | undefined {
    if (!header) return undefined;
    const [scheme, value] = header.split(' ');
    return scheme?.toLowerCase() === 'bearer' ? value : undefined;
  }
}
