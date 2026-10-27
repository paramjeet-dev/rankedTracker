import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { importLegacyQueue, insertSeedClans } from '../src/discovery/seed.js';

const url = process.env['TEST_DATABASE_URL'];
const skip = url ? false : 'set TEST_DATABASE_URL to run';
let pool: pg.Pool;

before(async () => {
  if (!url) return;
  pool = new pg.Pool({ connectionString: url, max: 3 });
  // the old crawler's queue table, as defined in db/schema.sql
  await pool.query(`CREATE TABLE IF NOT EXISTS job (
    id BIGSERIAL PRIMARY KEY, kind TEXT NOT NULL, payload JSONB NOT NULL, priority INT NOT NULL DEFAULT 100,
    run_after TIMESTAMPTZ NOT NULL DEFAULT now(), attempts INT NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed')),
    locked_at TIMESTAMPTZ, last_error TEXT, updated_at TIMESTAMPTZ DEFAULT now(), UNIQUE (kind, payload))`);
});
after(async () => void (await pool?.end()));
beforeEach(async () => {
  if (!url) return;
  await pool.query('TRUNCATE job, battle, group_fetch_state, group_member, player_season_result, player_name_history, league_group, season, player, clan CASCADE');
});

test('insertSeedClans adds only unknown clans, leaves them uncrawled, and keeps existing crawl state', { skip }, async () => {
  await pool.query(`INSERT INTO clan (clan_tag, name, members_crawled_at) VALUES ('#OLD', 'Old', now())`);
  assert.equal(await insertSeedClans(pool, ['#OLD', '#NEW1', '#NEW2', '#NEW1']), 2);
  assert.equal(await insertSeedClans(pool, ['#NEW1', '#NEW2']), 0);
  const rows = (await pool.query('SELECT clan_tag, members_crawled_at IS NULL AS fresh FROM clan ORDER BY 1')).rows;
  assert.deepEqual(rows.map((r) => [r.clan_tag, r.fresh]), [['#NEW1', true], ['#NEW2', true], ['#OLD', false]]);
});

test('legacy queue import: dry run counts, apply copies only the missing tags, job table untouched', { skip }, async () => {
  await pool.query(`INSERT INTO clan (clan_tag) VALUES ('#HAVE')`);
  await pool.query(`INSERT INTO player (player_tag) VALUES ('#PHAVE')`);
  await pool.query(`INSERT INTO job (kind, payload, status) VALUES
    ('clan_members', '{"clanTag":"#HAVE"}', 'queued'), ('clan_members', '{"clanTag":"#MISS1"}', 'queued'),
    ('clan_members', '{"clanTag":"#MISS2"}', 'running'), ('clan_members', '{"clanTag":"#DONE"}', 'done'),
    ('profile', '{"playerTag":"#PHAVE"}', 'queued'), ('profile', '{"playerTag":"#PMISS","full":true}', 'queued'),
    ('group_fetch', '{"groupTag":"#G","seasonId":"1","playerTag":"#X","tierId":1}', 'queued')`);
  const dry = await importLegacyQueue(pool, false);
  assert.deepEqual([dry.clans, dry.players, dry.appliedClans, dry.appliedPlayers], [{ queued: 3, missing: 2 }, { queued: 2, missing: 1 }, 0, 0]);
  assert.equal(Number((await pool.query('SELECT count(*) AS n FROM clan')).rows[0].n), 1, 'dry run writes nothing');
  const real = await importLegacyQueue(pool, true);
  assert.deepEqual([real.appliedClans, real.appliedPlayers], [2, 1]);
  assert.deepEqual((await pool.query('SELECT clan_tag FROM clan ORDER BY 1')).rows.map((r) => r.clan_tag), ['#HAVE', '#MISS1', '#MISS2']);
  assert.deepEqual((await pool.query('SELECT player_tag FROM player ORDER BY 1')).rows.map((r) => r.player_tag), ['#PHAVE', '#PMISS']);
  assert.equal(Number((await pool.query('SELECT count(*) AS n FROM job')).rows[0].n), 7);
  assert.equal((await importLegacyQueue(pool, true)).appliedClans, 0, 'idempotent');
});
