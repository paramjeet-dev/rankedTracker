import type { Logger } from './logger.js';
import { sleep } from './util.js';

/**
 * Shared API key set.
 *
 * Why this exists: clashofclans.js `login()` REVOKES every key with the same key name whose IP differs from the IP the
 * developer portal sees at that login. With one login per process, any IP inconsistency makes the processes revoke each
 * other's keys in a loop (403s everywhere, "Key #n is no longer valid", portal "Temporary application error"). So
 * exactly one process (`availability`, the KeyManager) logs in and publishes the keys; every other process only follows
 * (KeyFollower) and never touches the developer portal.
 */
export const KEYS_KEY = 'tracking:clash_keys';
export const KEYS_REFRESH_KEY = 'tracking:clash_keys_refresh';

export interface KV {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode?: 'EX', ttl?: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

export interface KeySet {
  version: number;
  keys: string[];
  publishedAt: number;
}

export async function readKeys(kv: KV): Promise<KeySet | null> {
  const raw = await kv.get(KEYS_KEY);
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as KeySet;
    return Array.isArray(s.keys) && typeof s.version === 'number' ? s : null;
  } catch {
    return null;
  }
}

export interface RefreshRequest {
  seenVersion: number;
  at: number;
}

export async function readRefreshRequest(kv: KV): Promise<RefreshRequest | null> {
  const raw = await kv.get(KEYS_REFRESH_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as RefreshRequest;
  } catch {
    return null;
  }
}

export interface ManagerOptions {
  /** Minimum time between two developer-portal logins. */
  cooldownMs?: number;
  clock?: () => number;
  sleep?: (ms: number) => Promise<unknown>;
  log?: Logger;
}

/** The only code that logs in. `login` must return the key strings of the account for the current IP. */
export class KeyManager {
  private version = 0;
  private lastAttemptAt = 0;
  private inFlight: Promise<void> | null = null;
  private readonly cooldownMs: number;
  private readonly clock: () => number;
  private readonly sleepFn: (ms: number) => Promise<unknown>;

  constructor(
    private readonly kv: KV,
    private readonly login: () => Promise<string[]>,
    private readonly opts: ManagerOptions = {}
  ) {
    this.cooldownMs = opts.cooldownMs ?? 20_000;
    this.clock = opts.clock ?? Date.now;
    this.sleepFn = opts.sleep ?? ((ms) => sleep(ms));
  }

  get currentVersion(): number {
    return this.version;
  }

  /** First login after (re)start. Versions keep increasing across restarts so followers always see "newer". */
  async init(): Promise<void> {
    this.version = (await readKeys(this.kv))?.version ?? 0;
    await this.doLogin('startup');
  }

  /** Log in again (single flight, spaced by the cooldown) and publish the new set. */
  relogin(reason: string): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = (async () => {
      const wait = this.cooldownMs - (this.clock() - this.lastAttemptAt);
      if (wait > 0) await this.sleepFn(wait);
      await this.doLogin(reason);
    })().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /** Serve a follower's "my keys are rejected" request. Returns true when a login was done for it. */
  async pollRefresh(): Promise<boolean> {
    const req = await readRefreshRequest(this.kv);
    if (!req) return false;
    if (req.seenVersion < this.version) {
      await this.kv.del(KEYS_REFRESH_KEY); // they are behind: a newer set is already published
      return false;
    }
    await this.relogin('follower reported rejected keys');
    await this.kv.del(KEYS_REFRESH_KEY);
    return true;
  }

  private async doLogin(reason: string): Promise<void> {
    this.lastAttemptAt = this.clock();
    try {
      const keys = await this.login();
      if (keys.length === 0) throw new Error('login returned no keys');
      this.version++;
      await this.kv.set(KEYS_KEY, JSON.stringify({ version: this.version, keys, publishedAt: this.clock() } satisfies KeySet));
      this.opts.log?.info(`published key set v${this.version} (${keys.length} keys) after: ${reason}`);
    } finally {
      this.lastAttemptAt = this.clock();
    }
  }
}

export interface FollowerOptions {
  pollMs?: number;
  /** How long recover() waits for the manager before giving up. */
  recoverTimeoutMs?: number;
  /** A recover() right after a successful one returns at once: the keys are fresh and stragglers just need to retry. */
  cooldownMs?: number;
  clock?: () => number;
  log?: Logger;
}

export class KeyFollower {
  version = 0;
  private lastRecoveredAt = -Infinity;
  private inFlight: Promise<void> | null = null;
  private timer: NodeJS.Timeout | undefined;
  private readonly pollMs: number;
  private readonly recoverTimeoutMs: number;
  private readonly cooldownMs: number;
  private readonly clock: () => number;

  constructor(
    private readonly kv: KV,
    private readonly apply: (keys: string[]) => void,
    private readonly opts: FollowerOptions = {}
  ) {
    this.pollMs = opts.pollMs ?? 1_000;
    this.recoverTimeoutMs = opts.recoverTimeoutMs ?? 120_000;
    this.cooldownMs = opts.cooldownMs ?? 10_000;
    this.clock = opts.clock ?? Date.now;
  }

  /** Apply a published set if it is newer than the one in use. */
  async adoptIfNewer(): Promise<boolean> {
    const s = await readKeys(this.kv);
    if (!s || s.version <= this.version) return false;
    this.apply([...s.keys]);
    this.version = s.version;
    return true;
  }

  async waitForInitial(signal?: AbortSignal, timeoutMs = 300_000): Promise<void> {
    const deadline = this.clock() + timeoutMs;
    let announced = false;
    while (!(await this.adoptIfNewer())) {
      if (signal?.aborted) throw new Error('aborted while waiting for API keys');
      if (this.clock() > deadline) throw new Error('No API keys were published to Valkey. Start `npm run availability` first.');
      if (!announced) {
        this.opts.log?.info('waiting for the key manager (`npm run availability`) to publish API keys...');
        announced = true;
      }
      await sleep(this.pollMs * 2, signal);
    }
    this.opts.log?.info(`using key set v${this.version}`);
  }

  /** Pick up key sets the manager publishes for any reason, before a request has to fail first. */
  watch(): () => void {
    if (!this.timer) {
      this.timer = setInterval(() => void this.adoptIfNewer().catch(() => undefined), Math.max(this.pollMs, 1_000) * 2);
      this.timer.unref();
    }
    return () => {
      if (this.timer) clearInterval(this.timer);
      this.timer = undefined;
    };
  }

  /** My keys were rejected (403): ask the manager for new ones and wait until they are published. */
  recover(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    if (this.clock() - this.lastRecoveredAt < this.cooldownMs) return Promise.resolve();
    this.inFlight = (async () => {
      const seen = this.version;
      const deadline = this.clock() + this.recoverTimeoutMs;
      for (;;) {
        if (await this.adoptIfNewer()) break;
        await this.kv.set(KEYS_REFRESH_KEY, JSON.stringify({ seenVersion: seen, at: this.clock() } satisfies RefreshRequest), 'EX', 60);
        if (this.clock() > deadline) throw new Error('The key manager published no new keys (is `npm run availability` running?)');
        await sleep(this.pollMs);
      }
      this.lastRecoveredAt = this.clock();
      this.opts.log?.info(`switched to key set v${this.version}`);
    })().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }
}
