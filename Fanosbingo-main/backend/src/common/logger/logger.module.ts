import { Module } from '@nestjs/common';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';
import * as crypto from 'crypto';

/**
 * Audit finding LOG-2 (High): Nest's default console Logger prints
 * human-formatted, unstructured lines — no JSON, nothing a log aggregator
 * (Loki/CloudWatch/Datadog) can index or query on fields. This swaps in Pino
 * everywhere Nest's `Logger` class is already used (no call-site changes
 * needed elsewhere in the codebase — `new Logger(SomeService.name)` keeps
 * working exactly as written), while adding:
 *   - a request ID on every request (`X-Request-Id`, generated if the
 *     caller/proxy didn't already supply one) — audit finding LOG-3, lets a
 *     support ticket or an error report be traced to its exact log lines
 *   - automatic request/response logging (method, path, status, duration)
 *     replacing the "no request logging at all" finding
 *   - redaction of the Authorization header and password/token fields so
 *     secrets never land in log output
 */
@Module({
  imports: [
    PinoLoggerModule.forRoot({
      pinoHttp: {
        genReqId: (req, res) => {
          const existing = req.headers['x-request-id'];
          const id = (Array.isArray(existing) ? existing[0] : existing) || crypto.randomUUID();
          res.setHeader('X-Request-Id', id);
          return id;
        },
        redact: {
          paths: [
            'req.headers.authorization',
            'req.headers.cookie',
            'req.body.password',
            'req.body.adminKey',
            'req.body.refreshToken',
            'req.body.initData',
            // Phase 8b: one-time temporary password returned by operator create().
            // Never log a plaintext credential, even in a response body.
            'res.body.temporaryPassword',
          ],
          censor: '[REDACTED]',
        },
        customLogLevel: (_req, res, err) => {
          if (res.statusCode >= 500 || err) return 'error';
          if (res.statusCode >= 400) return 'warn';
          return 'info';
        },
        // Pretty-print locally; ship raw JSON lines in production so a log
        // aggregator can parse them (set NODE_ENV=production to switch).
        transport: process.env.NODE_ENV === 'production' ? undefined : { target: 'pino-pretty', options: { singleLine: true } },
      },
    }),
  ],
  exports: [PinoLoggerModule],
})
export class LoggerModule {}
