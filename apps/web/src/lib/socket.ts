'use client';

import { io, type Socket } from 'socket.io-client';

/**
 * The API base is `.../api/v1`; the socket connects to the ORIGIN (Socket.IO
 * has its own path), so strip the API path.
 */
function socketOrigin(): string {
  const api = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001/api/v1';
  try {
    return new URL(api).origin;
  } catch {
    return 'http://localhost:3001';
  }
}

/**
 * Opens an authenticated socket. The access token goes in the handshake `auth`
 * payload, never a query string — a query string lands in server logs and
 * proxy caches. The server verifies it and joins this client to its own tenant
 * room; nothing here can choose the room.
 */
export function connectSocket(accessToken: string): Socket {
  return io(socketOrigin(), {
    transports: ['websocket'],
    auth: { token: accessToken },
  });
}
