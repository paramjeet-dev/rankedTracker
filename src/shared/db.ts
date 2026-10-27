import pg from 'pg';
import { config, envNumber } from './config.js';

/**
 * One small pool per process. The old crawler used DB_POOL=40; with several processes that would exceed
 * Postgres's default max_connections (100), so processes use their own PG_POOL_MAX (default 8).
 */
export function createPg(url: string = config.databaseUrl, max: number = envNumber('PG_POOL_MAX', 8)): pg.Pool {
  return new pg.Pool({ connectionString: url, max, idleTimeoutMillis: 30_000 });
}

/** Deadlock (40P01) and serialization failure (40001): safe to run the whole transaction again. */
export async function retryDeadlock<T>(fn: () => Promise<T>, tries = 5): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const code = (e as { code?: string } | null)?.code;
      if ((code === '40P01' || code === '40001') && i < tries) {
        await new Promise((r) => setTimeout(r, 20 + Math.random() * 120 * i));
        continue;
      }
      throw e;
    }
  }
}

async function txOnce<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Run fn in a transaction, retrying the whole transaction on deadlock. fn must only touch the database. */
export function withTx<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  return retryDeadlock(() => txOnce(pool, fn));
}
