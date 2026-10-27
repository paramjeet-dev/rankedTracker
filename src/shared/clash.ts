import { Client } from 'clashofclans.js';
import { classifyError, errorKey, type FailureKind } from './classify.js';
import { config } from './config.js';
import type { AvailabilityGate } from './gate.js';
import { createLogger } from './logger.js';
import type { Metrics } from './metrics.js';
import type { Pacer } from './pacer.js';
import { KeyFollower, KeyManager, type KV } from './keys.js';
import { backoffMs, retry, sleep } from './util.js';

const log = createLogger('clash');

/**
 * Create the library client in one of two modes (CLASH_KEYS_MODE):
 *  - "shared" (default): follow the key set that `availability` publishes to Valkey. This process never logs in, so it
 *    can never revoke another process's keys.
 *  - "login": log in directly (the old behaviour). Only safe when this is the ONLY process using the account.
 *
 * retryLimit is 0 on purpose: the library's own retry re-logs-in per request on a 403, which is exactly what must not
 * happen with many workers. restRequestTimeout must be set: the library default (0) means "never time out".
 */
export async function createClashClient(
  valkey: KV,
  signal?: AbortSignal
): Promise<{ client: Client; relogin: () => Promise<void>; close: () => void }> {
  if (config.clash.keysMode === 'login') {
    const { client, manager } = await createLoginClient(valkey, false, signal);
    return { client, relogin: () => manager.relogin('rejected keys'), close: () => undefined };
  }
  const client = new Client({ restRequestTimeout: config.clash.requestTimeoutMs, retryLimit: 0 });
  const follower = new KeyFollower(valkey, (keys) => void client.rest.requestHandler.setKeys(keys), { log });
  await follower.waitForInitial(signal);
  const stop = follower.watch();
  return { client, relogin: () => follower.recover(), close: stop };
}

/**
 * The login client used by `availability` (the key manager). It logs in with retries, then publishes the keys.
 * `publish: false` keeps the keys local (CLASH_KEYS_MODE=login).
 */
export async function createLoginClient(
  valkey: KV,
  publish = true,
  signal?: AbortSignal
): Promise<{ client: Client; manager: KeyManager }> {
  const client = new Client({ restRequestTimeout: config.clash.requestTimeoutMs, retryLimit: 0 });
  const login = async (): Promise<string[]> =>
    client.login({
      email: config.clash.email,
      password: config.clash.password,
      keyName: config.clash.keyName,
      keyCount: config.clash.keyCount
    });
  const sink: KV = publish ? valkey : memoryKv();
  const manager = new KeyManager(sink, login, { log });
  await retry(() => manager.init(), {
    attempts: 8,
    ...(signal && { signal }),
    onRetry: (err, attempt, wait) => log.warn(`login failed (attempt ${attempt}), retrying in ${Math.round(wait / 1000)}s: ${(err as Error).message.slice(0, 160)}`)
  });
  return { client, manager };
}

function memoryKv(): KV {
  const m = new Map<string, string>();
  return { get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, v), del: async (k) => void m.delete(k) };
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

  /** This process's keys were rejected: get new ones, then reopen this process's gate. */
  private async recoverKeys(): Promise<void> {
    if (!this.deps.relogin) return;
    try {
      await this.deps.relogin();
      this.deps.gate.reopen('keys refreshed');
    } catch (e) {
      log.error('could not get new keys; the gate stays closed until the auth hold elapses', e);
    }
  }

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
          // Start getting new keys right away (single flight inside the key follower). Calls waiting at the gate wake
          // up when it reopens, including this one if it is retried.
          if (c.kind === 'auth') void this.recoverKeys();
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
