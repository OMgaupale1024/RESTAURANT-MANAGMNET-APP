import type { ExecutionContext, CallHandler } from '@nestjs/common';
import type { PinoLogger } from 'nestjs-pino';
import { firstValueFrom, of } from 'rxjs';
import { delay } from 'rxjs/operators';
import { SlowRequestInterceptor } from './slow-request.interceptor';

type Warn = { obj: Record<string, unknown>; msg: string };

function ctx(req: Record<string, unknown>): ExecutionContext {
  return {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

function build() {
  const warns: Warn[] = [];
  const logger = {
    warn: (obj: Record<string, unknown>, msg: string) =>
      warns.push({ obj, msg }),
  } as unknown as PinoLogger;
  return { interceptor: new SlowRequestInterceptor(logger), warns };
}

describe('SlowRequestInterceptor', () => {
  it('does not warn on a fast request', async () => {
    const { interceptor, warns } = build();
    const handler: CallHandler = { handle: () => of('done') };
    await firstValueFrom(
      interceptor.intercept(
        ctx({ id: 'r1', method: 'GET', url: '/api/v1/orders' }),
        handler,
      ),
    );
    expect(warns).toHaveLength(0);
  });

  it('warns once, past the threshold, with the request id and masked path', async () => {
    const { interceptor, warns } = build();
    // 1100ms > the 1000ms threshold.
    const handler: CallHandler = { handle: () => of('done').pipe(delay(1100)) };
    await firstValueFrom(
      interceptor.intercept(
        ctx({ id: 'r2', method: 'POST', url: '/api/v1/join/SECRET-TOKEN' }),
        handler,
      ),
    );
    expect(warns).toHaveLength(1);
    expect(warns[0].msg).toBe('Slow request');
    expect(warns[0].obj.requestId).toBe('r2');
    expect(warns[0].obj.durationMs).toBeGreaterThanOrEqual(1000);
    // The invite token must not leak into the slow-request log either.
    expect(warns[0].obj.path).toBe('/api/v1/join/[REDACTED]');
  });
});
