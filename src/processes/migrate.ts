import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPg } from '../shared/db.js';
import { runProcess } from '../shared/process.js';

/** Applies sql/*.sql in name order, once each. Every file must be idempotent anyway. */
void runProcess('migrate', async ({ log }) => {
  const pool = createPg();
  try {
    await pool.query(
      'CREATE TABLE IF NOT EXISTS tracking_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())'
    );
    const done = new Set((await pool.query<{ name: string }>('SELECT name FROM tracking_migrations')).rows.map((r) => r.name));
    const dir = join(process.cwd(), 'sql');
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      if (done.has(file)) continue;
      log.info(`applying ${file}`);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(readFileSync(join(dir, file), 'utf8'));
        await client.query('INSERT INTO tracking_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    }
    log.info('up to date');
  } finally {
    await pool.end();
  }
});
