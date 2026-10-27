/**
 * Request pacer. Two jobs:
 *  1. Space request *starts* evenly (1000/rps ms apart) instead of releasing bursts each second.
 *  2. Cap simultaneous requests, so slow responses cannot snowball into hundreds of open connections.
 *
 * It also adapts: onPressure() halves the rate (down to minRps), and a long streak of successes
 * raises it again by 5% of maxRps per streak, up to maxRps. This is the circuit breaker the old
 * 32-worker crawler lacked.
 */
export interface PacerOptions {
  rps: number;
  maxInFlight: number;
  minRps?: number;
  maxRps?: number;
  /** Consecutive successes needed before the rate steps back up. */
  recoverAfter?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<unknown>;
}

export class Pacer {
  private rps: number;
  private readonly minRps: number;
  private readonly maxRps: number;
  private readonly maxInFlight: number;
  private readonly recoverAfter: number;
  private readonly now: () => number;
  private readonly sleepFn: (ms: number) => Promise<unknown>;
  private nextAt = 0;
  private inFlight = 0;
  private streak = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(opts: PacerOptions) {
    this.maxRps = opts.maxRps ?? opts.rps;
    this.minRps = opts.minRps ?? Math.max(0.5, this.maxRps / 20);
    this.rps = Math.min(this.maxRps, Math.max(this.minRps, opts.rps));
    this.maxInFlight = Math.max(1, opts.maxInFlight);
    this.recoverAfter = opts.recoverAfter ?? 50;
    this.now = opts.now ?? Date.now;
    this.sleepFn = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  get currentRps(): number {
    return this.rps;
  }
  get ceilingRps(): number {
    return this.maxRps;
  }
  get active(): number {
    return this.inFlight;
  }

  /** Wait for a permit and a start slot. Call the returned function when the request finishes. */
  async acquire(): Promise<() => void> {
    await this.takePermit();
    const now = this.now();
    const startAt = Math.max(now, this.nextAt);
    this.nextAt = startAt + 1000 / this.rps;
    const wait = startAt - now;
    if (wait > 0) await this.sleepFn(wait);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.releasePermit();
    };
  }

  onSuccess(): void {
    if (++this.streak >= this.recoverAfter) {
      this.streak = 0;
      this.rps = Math.min(this.maxRps, this.rps + this.maxRps * 0.05);
    }
  }

  onPressure(): void {
    this.streak = 0;
    this.rps = Math.max(this.minRps, this.rps / 2);
  }

  private takePermit(): Promise<void> {
    if (this.inFlight < this.maxInFlight) {
      this.inFlight++;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private releasePermit(): void {
    const next = this.waiters.shift();
    if (next) next(); // permit passes directly to the next waiter; inFlight stays the same
    else this.inFlight--;
  }
}
