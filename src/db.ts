import 'dotenv/config';
import pg from 'pg';

export const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: Number(process.env.DB_POOL ?? 40) });

/** Re-run on deadlock / serialization failure (40P01, 40001) with a short random pause. */
export async function retryDeadlock<T>(fn: () => Promise<T>, tries = 5): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e: any) {
      if ((e?.code === '40P01' || e?.code === '40001') && i < tries) {
        await new Promise(r => setTimeout(r, 20 + Math.random() * 120 * i));
        continue;
      }
      throw e;
    }
  }
}

export const tx = <T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> => retryDeadlock(() => txOnce(fn));

async function txOnce<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

export function normTag(tag: string): string {
  const t = tag.trim().toUpperCase().replace(/O/g, '0');
  return t.startsWith('#') ? t : '#' + t;
}
