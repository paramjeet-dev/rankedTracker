import { Client } from 'clashofclans.js';
import { classifyError, errorKey, type FailureKind } from './classify.js';
import { config } from './config.js';
import type { AvailabilityGate } from './gate.js';
import { createLogger } from './logger.js';
import type { Metrics } from './metrics.js';
import type { Pacer } from './pacer.js';
import { backoffMs, singleFlight, sleep } from './util.js';

const log = createLogger('clash');

/**
 * Create the library client.
 *
 * retryLimit is 0 on purpose: the library's own retry also re-logs-in per request on a 403 invalid-IP,
 * which with many workers means many simultaneous logins. We handle retries and re-login ourselves,
 * once, in the gateway. restRequestTimeout must be set: the library default (0) means "never time out".
 */
export async function createClashClient(): Promise<{ client: Client; relogin: () => Promise<void> }> {
  const client = new Client({ restRequestTimeout: config.clash.requestTimeoutMs, retryLimit: 0 });
  const login = async () => {
    await client.login({
      email: config.clash.email,
      password: config.clash.password,
      keyName: config.clash.keyName,
      keyCount: config.clash.keyCount
    });
  };
  await login();
  // One login at most per minute, shared by all concurrent callers.
  const relogin = singleFlight(async () => {
    log.warn('re-validating keys / logging in again');
    await login();
    log.info('re-login complete');
  }, 60_000);
  return { client, relogin };
}

export type CallResult<T> =
  | { ok: true; value: T; attempts: number }
  | { ok: false; kind: FailureKind; permanent: boolean; status?: number; message: string; attempts: number };

export interface CallOptions {
  /** Retries that count against the entity (500s, timeouts, throttling). Default 4. */
  maxAttempts?: number;
  /** Times a request may be re-run after the gate closed under it. Default 5. */
  maxGateRetries?: number;
  signal?: AbortSignal;
}

export interface GatewayDeps {
  client: Client;
  gate: AvailabilityGate;
  metrics: Metrics;
  pacers: Record<string, Pacer>;
  relogin?: () => Promise<void>;
}

/**
 * The single door to the Clash API. Every request:
 *   wait for the gate -> wait for a pacer slot -> run -> classify any failure.
 *
 * Failures never throw. A permanent failure (404, 400) tells the caller the entity is the problem.
 * A transient failure after bounded retries returns ok:false/permanent:false, and the caller should
 * simply leave the entity in its target set to be picked up on the next scan.
 */
export class ClashGateway {
  constructor(private readonly deps: GatewayDeps) {}

  async call<T>(pool: string, fn: (client: Client) => Promise<T>, opts: CallOptions = {}): Promise<CallResult<T>> {
    const pacer = this.deps.pacers[pool];
    if (!pacer) throw new Error(`Unknown pool "${pool}". Register a Pacer for it first.`);
    const maxAttempts = opts.maxAttempts ?? 4;
    const maxGateRetries = opts.maxGateRetries ?? 5;
    let attempts = 0;
    let gateRetries = 0;

    for (;;) {
      if (opts.signal?.aborted) return { ok: false, kind: 'aborted', permanent: true, message: 'aborted', attempts };
      await this.deps.gate.waitOpen(opts.signal);
      const release = await pacer.acquire();
      if (!this.deps.gate.isOpen || opts.signal?.aborted) {
        release(); // the gate closed while this request waited for its slot
        continue;
      }

      const started = Date.now();
      let waitMs = 0;
      try {
        const value = await fn(this.deps.client);
        pacer.onSuccess();
        this.deps.metrics.record(pool, 'ok', Date.now() - started);
        return { ok: true, value, attempts: attempts + 1 };
      } catch (err) {
        const c = classifyError(err);
        this.deps.metrics.record(pool, c.kind, Date.now() - started, errorKey(c));
        if (c.pressure) pacer.onPressure();
        if (c.closesGate) {
          this.deps.gate.close(c.kind);
          if (c.kind === 'auth') this.deps.relogin?.().catch((e) => log.error('re-login failed', e));
        }
        attempts++;
        const fail = (): CallResult<T> => ({
          ok: false,
          kind: c.kind,
          permanent: c.permanent,
          message: c.message,
          attempts,
          ...(c.status !== undefined && { status: c.status })
        });
        if (c.permanent) return fail();
        if (c.closesGate) {
          // The shared gate handles the waiting. Bounded so one poisoned request cannot loop forever.
          if (++gateRetries > maxGateRetries) return fail();
          attempts--; // outages are not the entity's fault
        } else if (attempts >= maxAttempts) {
          return fail();
        } else {
          waitMs = backoffMs(attempts, c.kind === 'throttled' ? 3_000 : 1_500);
        }
      } finally {
        release();
      }
      if (waitMs > 0 && !(await sleep(waitMs, opts.signal))) {
        return { ok: false, kind: 'aborted', permanent: true, message: 'aborted', attempts };
      }
    }
  }
}
