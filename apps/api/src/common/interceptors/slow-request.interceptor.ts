import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import type { Request } from 'express';
import { tap } from 'rxjs';
import { redactUrl } from '../logging/redact-url';

// A request slower than this is worth a second look — a missing index, an N+1,
// a slow upstream. Not an error, so it is a warn, not an error.
const SLOW_REQUEST_MS = 1000;

/**
 * Flags requests that take longer than the threshold with a single warn line,
 * carrying the same request id as the access log so the two correlate. pino-http
 * already logs every request's duration at info; this raises the slow ones so
 * they are greppable without trawling the whole access log.
 */
@Injectable()
export class SlowRequestInterceptor implements NestInterceptor {
  constructor(private readonly logger: PinoLogger) {}

  intercept(context: ExecutionContext, next: CallHandler) {
    // Only HTTP requests have a duration worth measuring here.
    if (context.getType() !== 'http') return next.handle();

    const req = context.switchToHttp().getRequest<Request>();
    const start = Date.now();

    return next.handle().pipe(
      tap(() => {
        const durationMs = Date.now() - start;
        if (durationMs >= SLOW_REQUEST_MS) {
          this.logger.warn(
            {
              requestId: typeof req.id === 'string' ? req.id : undefined,
              method: req.method,
              path: redactUrl(req.originalUrl ?? req.url),
              durationMs,
            },
            'Slow request',
          );
        }
      }),
    );
  }
}
