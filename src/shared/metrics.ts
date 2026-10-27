import type { Redis } from 'ioredis';
import { createLogger } from './logger.js';
import type { Pacer } from './pacer.js';

interface PoolWindow {
  requests: number;
  ok: number;
  latencyMs: number;
  byKind: Map<string, number>;
  byKey: Map<string, number>;
}

const empty = (): PoolWindow => ({ requests: 0, ok: 0, latencyMs: 0, byKind: new Map(), byKey: new Map() });

/**
 * Per-pool request metrics. Each pool reports its own observed RPS, errors, and latency,
 * instead of one blended number. The `byKey` breakdown (kind:status:reason) is what finally
 * shows *which* failure is behind errors like "Unexpected token '<'".
 */
export class Metrics {
  private windows = new Map<string, PoolWindow>();
  private totals = new Map<string, { ok: number; err: number }>();

  record(pool: string, kind: 'ok' | string, latencyMs: number, key?: string): void {
    const w = this.windows.get(pool) ?? empty();
    this.windows.set(pool, w);
    const t = this.totals.get(pool) ?? { ok: 0, err: 0 };
    this.totals.set(pool, t);
    w.requests++;
    w.latencyMs += latencyMs;
    if (kind === 'ok') {
      w.ok++;
      t.ok++;
    } else {
      t.err++;
      w.byKind.set(kind, (w.byKind.get(kind) ?? 0) + 1);
      if (key) w.byKey.set(key, (w.byKey.get(key) ?? 0) + 1);
    }
  }

  /** Read and reset the current window for a pool. */
  drain(pool: string, seconds: number) {
    const w = this.windows.get(pool) ?? empty();
    this.windows.set(pool, empty());
    const t = this.totals.get(pool) ?? { ok: 0, err: 0 };
    return {
      pool,
      observedRps: seconds > 0 ? w.requests / seconds : 0,
      requests: w.requests,
      ok: w.ok,
      errors: w.requests - w.ok,
      avgLatencyMs: w.requests ? Math.round(w.latencyMs / w.requests) : 0,
      topErrors: [...w.byKey.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4),
      totalOk: t.ok,
      totalErr: t.err
    };
  }

  pools(): string[] {
    return [...this.totals.keys()];
  }
}

export function startMetricsReporter(opts: {
  processName: string;
  metrics: Metrics;
  pacers: Record<string, Pacer>;
  valkey?: Redis | null;
  intervalMs?: number;
}): () => void {
  const log = createLogger('metrics');
  const intervalMs = opts.intervalMs ?? 30_000;
  const timer = setInterval(() => {
    for (const pool of opts.metrics.pools()) {
      const s = opts.metrics.drain(pool, intervalMs / 1000);
      const pacer = opts.pacers[pool];
      const limit = pacer ? `${pacer.currentRps.toFixed(1)}/${pacer.ceilingRps.toFixed(1)}` : '-';
      const top = s.topErrors.map(([k, n]) => `${k}x${n}`).join(' ');
      log.info(
        `${pool} rps=${s.observedRps.toFixed(1)} (limit ${limit}) ok=${s.ok} err=${s.errors} avg=${s.avgLatencyMs}ms` +
          (top ? ` top=[${top}]` : '')
      );
      opts.valkey
        ?.hset(`tracking:metrics:${opts.processName}:${pool}`, {
          observed_rps: s.observedRps.toFixed(2),
          limit_rps: pacer ? pacer.currentRps.toFixed(2) : '',
          ok: s.ok,
          errors: s.errors,
          avg_latency_ms: s.avgLatencyMs,
          total_ok: s.totalOk,
          total_err: s.totalErr,
          updated_at: Date.now()
        })
        .catch(() => undefined);
    }
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
