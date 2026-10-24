import 'dotenv/config';
import pg from 'pg';

export const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: Number(process.env.DB_POOL ?? 40) });

export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
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
