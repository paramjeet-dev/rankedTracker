import { test } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import { retryDeadlock, withTx } from '../src/shared/db.js';

test('retryDeadlock re-runs on deadlock and serialization failures only', async () => {
  let n = 0;
  assert.equal(await retryDeadlock(async () => { if (++n < 3) throw Object.assign(new Error('d'), { code: '40P01' }); return 'ok'; }), 'ok');
  assert.equal(n, 3);
  let m = 0;
  await assert.rejects(retryDeadlock(async () => { m++; throw Object.assign(new Error('x'), { code: '23505' }); }), /x/);
  assert.equal(m, 1, 'other errors are not retried');
  let k = 0;
  await assert.rejects(retryDeadlock(async () => { k++; throw Object.assign(new Error('d'), { code: '40001' }); }, 3));
  assert.equal(k, 3, 'bounded');
});

test('withTx rolls back and retries the whole transaction on deadlock, releasing every client', async () => {
  const log: string[] = [];
  let attempts = 0;
  const pool = {
    connect: async () => ({
      query: async (sql: string) => void log.push(sql),
      release: () => void log.push('release')
    })
  } as unknown as pg.Pool;
  const out = await withTx(pool, async () => {
    if (++attempts === 1) throw Object.assign(new Error('deadlock'), { code: '40P01' });
    return 'done';
  });
  assert.equal(out, 'done');
  assert.deepEqual(log, ['BEGIN', 'ROLLBACK', 'release', 'BEGIN', 'COMMIT', 'release']);
});
