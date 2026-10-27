import { AVAILABILITY_KEY, type AvailabilityState } from './availability-state.js';
import { createLogger } from './logger.js';

export interface KeyValueReader {
  get(key: string): Promise<string | null>;
}

export interface GateOptions {
  /** How often the local watcher reads the shared state. */
  pollMs?: number;
  /** A controller heartbeat older than this counts as "controller absent". */
  controllerStaleMs?: number;
  /** With no controller, reopen on this cadence and let live traffic act as the probe. */
  halfOpenMs?: number;
  clock?: () => number;
}

/**
 * Process-local request gate backed by the shared availability state.
 *
 * - Any request that sees an unavailable error calls close(); every other worker then stops *before*
 *   starting its request instead of retrying independently.
 * - The gate reopens only on a controller heartbeat newer than its own closure and reporting available.
 * - If the controller is not running (state key missing or stale), the gate reopens after halfOpenMs so
 *   the process cannot deadlock; the next failure closes it again.
 */
export class AvailabilityGate {
  private closedAt: number | null = null;
  private closedReason = '';
  private timer: NodeJS.Timeout | undefined;
  private readonly waiters: Array<() => void> = [];
  private readonly log = createLogger('gate');
  private readonly pollMs: number;
  private readonly staleMs: number;
  private readonly halfOpenMs: number;
  private readonly clock: () => number;

  constructor(
    private readonly kv: KeyValueReader | null,
    opts: GateOptions = {}
  ) {
    this.pollMs = opts.pollMs ?? 2_000;
    this.staleMs = opts.controllerStaleMs ?? 45_000;
    this.halfOpenMs = opts.halfOpenMs ?? 30_000;
    this.clock = opts.clock ?? Date.now;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.refresh().catch(() => undefined), this.pollMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.wakeAll();
  }

  get isOpen(): boolean {
    return this.closedAt === null;
  }

  get reason(): string {
    return this.closedReason;
  }

  close(reason: string): void {
    if (this.closedAt !== null) return;
    this.closedAt = this.clock();
    this.closedReason = reason;
    this.log.warn(`closed (${reason}); workers pause until a healthy heartbeat`);
  }

  async waitOpen(signal?: AbortSignal): Promise<void> {
    while (!this.isOpen) {
      if (signal?.aborted) return;
      await new Promise<void>((resolve) => {
        const done = () => {
          signal?.removeEventListener('abort', done);
          resolve();
        };
        this.waiters.push(done);
        signal?.addEventListener('abort', done, { once: true });
      });
    }
  }

  async refresh(): Promise<void> {
    const now = this.clock();
    let state: AvailabilityState | null = null;
    if (this.kv) {
      try {
        const raw = await this.kv.get(AVAILABILITY_KEY);
        state = raw ? (JSON.parse(raw) as AvailabilityState) : null;
      } catch {
        state = null; // Valkey unreachable: behave as "no controller"
      }
    }
    const fresh = state !== null && now - state.heartbeat <= this.staleMs;

    if (this.closedAt === null) {
      if (fresh && state && !state.available) {
        this.close(state.maintenance ? 'maintenance' : (state.reason ?? 'unavailable'));
      }
      return;
    }
    if (fresh && state?.available && state.heartbeat > this.closedAt) {
      return this.open('controller reports healthy');
    }
    if (!fresh && now - this.closedAt >= this.halfOpenMs) {
      return this.open('no controller heartbeat, trial reopen');
    }
  }

  private open(why: string): void {
    this.log.info(`reopened (${why})`);
    this.closedAt = null;
    this.closedReason = '';
    this.wakeAll();
  }

  private wakeAll(): void {
    for (const w of this.waiters.splice(0)) w();
  }
}
