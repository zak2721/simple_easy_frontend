import { Controller, Get, Header } from '@nestjs/common';
import * as client from 'prom-client';
import { Public } from '../common/decorators/public.decorator';

/**
 * Audit finding LOG-4 (High): no metrics endpoint existed at all — the only
 * signal on system health was the shallow /health check. Default Node/process
 * metrics (event loop lag, heap, GC, open handles) plus the app-specific
 * counters registered in MetricsModule give Prometheus/Grafana something to
 * actually alert on (e.g. p99 latency climbing, event loop lag spiking under
 * the cron's DB-heavy ticks). Not admin-authenticated: Prometheus scrapers
 * don't carry a JWT — this is the standard "metrics endpoint is
 * network-isolated, not app-authenticated" pattern (see docker-compose's
 * Prometheus service, which is not published to a host port).
 */
@Controller('metrics')
export class MetricsController {
  @Public()
  @Get()
  @Header('Content-Type', client.register.contentType)
  async getMetrics(): Promise<string> {
    return client.register.metrics();
  }
}
