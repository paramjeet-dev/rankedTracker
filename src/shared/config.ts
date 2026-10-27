import 'dotenv/config';

/** Read an env var, falling back to a default. Throws only when neither exists. */
export function env(name: string, fallback?: string): string {
  const value = process.env[name];
  if (value !== undefined && value !== '') return value;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required environment variable ${name}`);
}

/** First defined name wins, so the old COC_* names keep working next to the new CLASH_* names. */
export function envAny(names: string[], fallback?: string): string {
  for (const n of names) {
    const v = process.env[n];
    if (v !== undefined && v !== '') return v;
  }
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required environment variable ${names.join(' or ')}`);
}

export function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Environment variable ${name} must be a number, got "${raw}"`);
  return n;
}

export interface PoolConfig {
  /** Target request starts per second (the ceiling; the pacer may run lower under pressure). */
  rps: number;
  /** Hard cap on simultaneous requests for this pool. */
  maxInFlight: number;
}

/**
 * Per-pool request budget. Override with POOL_<NAME>_RPS and POOL_<NAME>_MAX_IN_FLIGHT,
 * e.g. POOL_GROUPS_RPS=6. Pool names are upper-cased and "-" becomes "_".
 */
export function poolConfig(pool: string, defaults: PoolConfig): PoolConfig {
  const key = pool.toUpperCase().replace(/-/g, '_');
  return {
    rps: envNumber(`POOL_${key}_RPS`, defaults.rps),
    maxInFlight: envNumber(`POOL_${key}_MAX_IN_FLIGHT`, defaults.maxInFlight)
  };
}

export const config = {
  get valkeyUrl(): string {
    return env('VALKEY_URL', 'redis://127.0.0.1:6379');
  },
  get databaseUrl(): string {
    return env('DATABASE_URL');
  },
  clash: {
    get email(): string {
      return envAny(['CLASH_EMAIL', 'COC_EMAIL']);
    },
    get password(): string {
      return envAny(['CLASH_PASSWORD', 'COC_PASSWORD']);
    },
    get keyName(): string {
      return env('CLASH_KEY_NAME', 'clashofclans.js.keys');
    },
    get keyCount(): number {
      return Number(envAny(['CLASH_KEY_COUNT', 'COC_KEY_COUNT'], '1'));
    },
    /** Without a timeout the library waits forever on a hung connection (its default is 0 = none). */
    get requestTimeoutMs(): number {
      return envNumber('CLASH_REQUEST_TIMEOUT_MS', 15_000);
    }
  },
  /** Ranked seasons are one week: ids are start times, Monday 05:00 UTC. */
  get seasonSeconds(): number {
    return envNumber('SEASON_SECONDS', 604_800);
  },
  profile: {
    /** Store finished seasons only for the tracked tiers (league_tier.in_scope). Set HISTORY_SCOPE_ONLY=false to keep everything. */
    get historyScopeOnly(): boolean {
      return env('HISTORY_SCOPE_ONLY', 'true') !== 'false';
    }
  },
  discovery: {
    get refreshDays(): number {
      return envNumber('DISCOVERY_REFRESH_DAYS', 7);
    },
    pageSize: 500
  },
  availability: {
    probeIntervalMs: 15_000,
    /** State key lifetime: if the controller dies, the key disappears after this long. */
    stateTtlSeconds: 45
  }
};
