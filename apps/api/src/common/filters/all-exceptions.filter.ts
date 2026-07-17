import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import type { Request, Response } from 'express';

type ErrorBody = {
  statusCode: number;
  error: string;
  message: string | string[];
  requestId: string;
};

// Single error shape for the whole API. Unknown errors never leak internals:
// the stack is logged server-side and the client gets a requestId to quote.
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(private readonly logger: PinoLogger) {}

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();
    // pino-http types req.id loosely; it is a string in practice (genReqId
    // returns randomUUID). Narrow rather than String()-ing an unknown, which
    // could stringify an object into "[object Object]" in a log.
    const requestId = typeof req.id === 'string' ? req.id : '';

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();

      // ValidationPipe returns { message: string[], error: string }
      const body: ErrorBody =
        typeof payload === 'string'
          ? {
              statusCode: status,
              error: exception.name,
              message: payload,
              requestId,
            }
          : {
              statusCode: status,
              error:
                (payload as Record<string, unknown>).error?.toString() ??
                exception.name,
              message: (payload as Record<string, unknown>).message as
                string | string[],
              requestId,
            };

      // 4xx is client error and expected; only warn.
      this.logger.warn({ err: exception, requestId }, 'Handled exception');
      res.status(status).json(body);
      return;
    }

    // Anything unrecognised is a bug. Log it fully, tell the client nothing.
    this.logger.error({ err: exception, requestId }, 'Unhandled exception');
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      error: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected error occurred.',
      requestId,
    } satisfies ErrorBody);
  }
}
