import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Response } from 'express';
import * as Sentry from '@sentry/node';

/**
 * Single place error responses are shaped. Never leaks stack traces, SQL, or
 * internal details to the client (spec §45/§62) — those go to the server log only.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();

    const isHttp = exception instanceof HttpException;
    const status = isHttp ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const body = isHttp ? exception.getResponse() : null;

    const message =
      isHttp && typeof body === 'object' && body !== null && 'message' in body
        ? (body as { message: string | string[] }).message
        : isHttp
          ? exception.message
          : 'Internal server error';

    if (!isHttp) {
      this.logger.error(exception instanceof Error ? exception.stack : String(exception));
      // Only genuine 500s go to Sentry — a 4xx (bad input, not found, etc.)
      // is expected traffic, not an incident. No-ops if SENTRY_DSN is unset.
      Sentry.captureException(exception);
    }

    res.status(status).json({
      success: false,
      statusCode: status,
      error: Array.isArray(message) ? message[0] : message,
      errors: Array.isArray(message) ? message : undefined,
    });
  }
}
