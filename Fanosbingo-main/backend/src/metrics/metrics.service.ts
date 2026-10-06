import { Injectable, OnModuleInit } from '@nestjs/common';
import * as client from 'prom-client';

/**
 * Registers Node/process default metrics (event loop lag, heap, GC, active
 * handles) plus the business-specific counters this app actually needs to
 * alert on. Injected wherever a mutation should be counted — kept to the
 * highest-value signals (money movement + the game cron's own liveness,
 * see audit finding LOG-4's "is the cron even still ticking" gap) rather
 * than instrumenting every method in the codebase.
 */
@Injectable()
export class MetricsService implements OnModuleInit {
  readonly httpRequestDuration = new client.Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration in seconds',
    labelNames: ['method', 'route', 'status_code'],
    buckets: [0.01, 0.05, 0.1, 0.3, 0.5, 1, 2, 5],
  });

  readonly depositsTotal = new client.Counter({
    name: 'yena_deposits_total',
    help: 'Manual deposits submitted, by outcome',
    labelNames: ['decision'],
  });

  readonly withdrawalsTotal = new client.Counter({
    name: 'yena_withdrawals_total',
    help: 'Withdrawals processed, by outcome',
    labelNames: ['decision'],
  });

  readonly bonusGrantsTotal = new client.Counter({
    name: 'yena_bonus_grants_total',
    help: 'Bonus grants, by reason',
    labelNames: ['reason'],
  });

  readonly gameCronLastSuccessTimestamp = new client.Gauge({
    name: 'yena_game_cron_last_success_timestamp_seconds',
    help: 'Unix timestamp of the last successful callNumbersTick — alert if this stops advancing (see games.service.ts)',
  });

  readonly gameCronFailuresTotal = new client.Counter({
    name: 'yena_game_cron_failures_total',
    help: 'callNumbersTick exceptions caught (the tick already swallows these to keep running — this makes them visible)',
  });

  onModuleInit() {
    client.collectDefaultMetrics();
  }
}
