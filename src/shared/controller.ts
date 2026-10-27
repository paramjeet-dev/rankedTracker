import { classifyError } from './classify.js';
import type { AvailabilityState } from './availability-state.js';
import { createLogger } from './logger.js';

export interface ControllerDeps {
  /** A tiny, dependable request (locations, limit 1). Must NOT go through the gateway or its gate. */
  probe: () => Promise<unknown>;
  publish: (state: AvailabilityState) => Promise<void>;
  emit?: (type: string, fields: Record<string, string | number | boolean>) => Promise<void>;
  relogin?: () => Promise<void>;
  clock?: () => number;
}

type ProbeResult = 'ok' | 'maintenance' | 'auth' | 'unavailable';

/**
 * Availability controller: one probe, one shared answer to "should Clash requests run now?"
 * It distinguishes official maintenance from a proxy/network outage and preserves the original
 * outage start across failed probes so the recovery duration is measured correctly.
 */
export class AvailabilityController {
  private current: { available: boolean; maintenance: boolean; reason?: string; since: number };
  private readonly clock: () => number;
  private readonly log = createLogger('availability');

  constructor(private readonly deps: ControllerDeps) {
    this.clock = deps.clock ?? Date.now;
    this.current = { available: true, maintenance: false, since: this.clock() };
  }

  async tick(): Promise<AvailabilityState> {
    const now = this.clock();
    const result = await this.probeOnce();

    if (result === 'ok') {
      if (!this.current.available) {
        const durationMs = now - this.current.since;
        this.log.info(`recovered after ${Math.round(durationMs / 1000)}s (maintenance=${this.current.maintenance})`);
        await this.deps.emit?.('availability.recovered', { maintenance: this.current.maintenance, durationMs }).catch(() => undefined);
        this.current = { available: true, maintenance: false, since: now };
      }
    } else if (this.current.available) {
      this.log.warn(`unavailable (${result})`);
      this.current = { available: false, maintenance: result === 'maintenance', reason: result, since: now };
    } else if (result === 'maintenance' && !this.current.maintenance) {
      this.current = { ...this.current, maintenance: true, reason: 'maintenance' };
    }

    const state: AvailabilityState = { ...this.current, heartbeat: now };
    await this.deps.publish(state);
    return state;
  }

  private async probeOnce(): Promise<ProbeResult> {
    try {
      await this.deps.probe();
      return 'ok';
    } catch (err) {
      const c = classifyError(err);
      if (c.kind === 'throttled') return 'ok'; // reachable but busy: the pacer handles this, not the gate
      if (c.kind === 'maintenance') return 'maintenance';
      if (c.kind === 'auth') {
        this.deps.relogin?.().catch((e) => this.log.error('re-login failed', e));
        return 'auth';
      }
      this.log.warn(`probe failed: ${c.kind} ${c.status ?? ''} ${c.message.slice(0, 120)}`);
      return 'unavailable';
    }
  }
}
