import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { loadScope } from '../src/shared/scope.js';

const url = process.env['TEST_DATABASE_URL'];
const skip = url ? false : 'set TEST_DATABASE_URL to run';
let pool: pg.Pool;

before(async () => {
  if (url) pool = new pg.Pool({ connectionString: url, max: 2 });
});
after(async () => void (await pool?.end()));
beforeEach(async () => {
  if (url) await pool.query('TRUNCATE league_tier');
});

test('scope is read from league_tier.in_scope', { skip }, async () => {
  await pool.query(`INSERT INTO league_tier (tier_id, name, in_scope)
    SELECT 105000000 + g, 'T' || g, g BETWEEN 26 AND 33 FROM generate_series(1, 37) g`);
  const s = await loadScope(pool);
  assert.equal(s.min, 105000026);
  assert.equal(s.max, 105000033);
  assert.equal(s.has(105000030), true);
  assert.equal(s.has(105000034), false);
  assert.equal(s.has(null), false);
});

test('empty and non-contiguous scope fail loudly', { skip }, async () => {
  await assert.rejects(loadScope(pool), /seed-tiers/);
  await pool.query(`INSERT INTO league_tier (tier_id, in_scope) VALUES (105000026, true), (105000028, true)`);
  await assert.rejects(loadScope(pool), /contiguous/);
});
