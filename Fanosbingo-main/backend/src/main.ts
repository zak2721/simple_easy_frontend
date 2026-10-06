import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { Logger } from 'nestjs-pino';
import * as Sentry from '@sentry/node';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import * as express from 'express';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';

/**
 * Audit finding SEC-1 (High): ThrottlerGuard (and any other req.ip-keyed
 * logic) resolves to the reverse proxy's own IP for every request unless
 * Express is told to trust the proxy's X-Forwarded-For header — in any real
 * deployment (this app always sits behind Caddy, see Caddyfile) that
 * collapses every distinct client into ONE shared rate-limit bucket: either
 * one attacker exhausts the admin-login budget for everyone (DoS), or the
 * limit becomes meaningless. `1` = trust exactly one hop (the immediate
 * proxy) — matches this app's actual topology (Caddy terminates TLS and
 * proxies directly to this container, docker-compose.prod.yml) and avoids
 * blindly trusting an arbitrary chain of forwarded-for headers a client
 * could otherwise spoof.
 */
// Audit finding LOG-5 (High): no error-tracking/APM product existed anywhere
// — the team was blind to production errors in real time, with server logs
// as the only signal and nobody alerted on them. Sentry.init with an empty
// `dsn` is a documented no-op (the SDK stays fully disabled, zero network
// calls) — safe to leave this unconditional so dev/CI never need a DSN.
Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV ?? 'development',
  tracesSampleRate: 0.1,
});

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));

  app.getHttpAdapter().getInstance().set('trust proxy', 1);

  // Express's default JSON body limit (100KB) is well under a real deposit/
  // withdrawal receipt photo — StorageService's own 10MB cap is meaningless
  // if the request never gets past this layer. Matches that cap with a
  // small margin for the base64 encoding overhead (~33%) and JSON envelope.
  app.use(express.json({ limit: '14mb' }));

  app.use(helmet());
  // Only the admin refresh token is sent as a cookie (httpOnly, path-scoped); see AuthController.
  app.use(cookieParser());
  app.enableCors({
    origin: (process.env.CORS_ALLOWED_ORIGINS ?? 'http://localhost:5173').split(',').map((s) => s.trim()),
    credentials: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());

  app.setGlobalPrefix('api');

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  app.get(Logger).log(`yena-bingo backend listening on :${port}`);
}

bootstrap();
