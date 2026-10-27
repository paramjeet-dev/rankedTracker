import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { PgGroupsRepo, targetCursor } from '../src/groups/repo.js';

const url = process.env['TEST_DATABASE_URL'];
const skip = url ? false : 'set TEST_DATABASE_URL to run';
const MIN = 105000026;
const MAX = 105000033;
const CUR = '1792386000';
const PREV = '1791781200';
let pool: pg.Pool;
let repo: PgGroupsRepo;

before(async () => {
  if (!url) return;
  pool = new pg.Pool({ connectionString: url, max: 4 });
  for (const f of ['sql/002_profile_state.sql', 'sql/004_group_registration.sql']) await pool.query(readFileSync(f, 'utf8'));
  repo = new PgGroupsRepo(pool, { minTier: MIN, maxTier: MAX, seasonSeconds: 604_800 });
});
after(async () => void (await pool?.end()));
beforeEach(async () => {
  if (!url) return;
  await pool.query('TRUNCATE battle, group_fetch_state, group_member, player_season_result, player_name_history, league_group, season, player, clan CASCADE');
  for (const s of [CUR, PREV]) {
    await pool.query(`INSERT INTO season (season_id, starts_at, ends_at) SELECT x.s, to_timestamp(x.s::bigint), to_timestamp(x.s::bigint + 604800) FROM (SELECT $1::text AS s) x`, [s]);
  }
});

async function seedPlayers() {
  const cur = (tag: string, tier: number | null, group: string) =>
    pool.query(`INSERT INTO player (player_tag, tier_id, current_group_tag, current_group_season_id) VALUES ($1, $2, $3, $4)`, [tag, tier, group, CUR]);
  await cur('#P1', MIN, '#G1');
  await cur('#P2', MIN + 1, '#G1'); // sibling of P1: same group, must not produce a second target
  await cur('#P3', 105000036, '#G9'); // out of scope now
  await cur('#P4', MIN, '#G2'); // group already stored
  await cur('#P5', MIN, '#G3'); // gone
  await cur('#P6', MIN, '#G4'); // backing off
  await cur('#P10', MIN + 2, '#G8'); // back-off expired
  await pool.query(`INSERT INTO league_group (group_tag, season_id, tier_id) VALUES ('#G2', $1, ${MIN})`, [CUR]);
  await pool.query(`INSERT INTO group_fetch_state (group_tag, season_id, gone_at) VALUES ('#G3', $1, now())`, [CUR]);
  await pool.query(`INSERT INTO group_fetch_state (group_tag, season_id, fail_count, next_attempt_at) VALUES ('#G4', $1, 1, now() + interval '1 hour'), ('#G8', $1, 1, now() - interval '1 hour')`, [CUR]);

  const prev = (tag: string, group: string, resultTier: number | null) =>
    pool.query(`INSERT INTO player (player_tag, tier_id, previous_group_tag, previous_group_season_id) VALUES ($1, $2, $3, $4)`, [tag, MIN, group, PREV]).then(async () => {
      if (resultTier !== null) await pool.query(`INSERT INTO player_season_result (player_tag, season_id, tier_id) VALUES ($1, $2, $3)`, [tag, PREV, resultTier]);
    });
  await prev('#P7', '#G5', MAX); // previous group in scope, tier comes from the history result
  await prev('#P8', '#G6', 105000010); // previous season was out of scope
  await prev('#P9', '#G7', null); // no history result: tier unknown, skipped
}

test('targets: one representative per unstored in-scope group, current and previous, tiers from the right source', { skip }, async () => {
  await seedPlayers();
  const all = await repo.loadTargets('', 50);
  assert.deepEqual(all.map((t) => [t.groupTag, t.seasonId, t.playerTag, t.tierId]), [
    ['#G1', CUR, '#P1', MIN],
    ['#G5', PREV, '#P7', MAX],
    ['#G8', CUR, '#P10', MIN + 2]
  ]);
  assert.equal(await repo.countTargets(), 3);
});

test('keyset paging resumes after the composite cursor', { skip }, async () => {
  await seedPlayers();
  const first = await repo.loadTargets('', 2);
  assert.deepEqual(first.map((t) => t.groupTag), ['#G1', '#G5']);
  const rest = await repo.loadTargets(targetCursor(first[1]!), 2);
  assert.deepEqual(rest.map((t) => t.groupTag), ['#G8']);
  assert.deepEqual(await repo.loadTargets(targetCursor(rest[0]!), 2), []);
});

test('the same group tag in two seasons is two targets', { skip }, async () => {
  await pool.query(`INSERT INTO player (player_tag, tier_id, current_group_tag, current_group_season_id, previous_group_tag, previous_group_season_id) VALUES ('#Q1', ${MIN}, '#GX', $1, '#GX', $2)`, [CUR, PREV]);
  await pool.query(`INSERT INTO player_season_result (player_tag, season_id, tier_id) VALUES ('#Q1', $1, ${MIN})`, [PREV]);
  assert.deepEqual((await repo.loadTargets('', 10)).map((t) => [t.groupTag, t.seasonId]), [['#GX', PREV], ['#GX', CUR]]);
});

test('markGone removes a group for good; recordFailure backs it off exponentially', { skip }, async () => {
  await seedPlayers();
  const [g1, g5] = await repo.loadTargets('', 50);
  await repo.markGone(g1!);
  await repo.recordFailure(g5!);
  assert.deepEqual((await repo.loadTargets('', 50)).map((t) => t.groupTag), ['#G8']);
  const a = (await pool.query(`SELECT fail_count, extract(epoch FROM next_attempt_at - now()) AS s FROM group_fetch_state WHERE group_tag='#G5'`)).rows[0];
  assert.equal(a.fail_count, 1);
  assert.ok(a.s > 50 && a.s <= 60);
  await repo.recordFailure(g5!);
  const b = (await pool.query(`SELECT fail_count, extract(epoch FROM next_attempt_at - now()) AS s FROM group_fetch_state WHERE group_tag='#G5'`)).rows[0];
  assert.equal(b.fail_count, 2);
  assert.ok(b.s > 110 && b.s <= 120);
});

test('a stored group disappears from the targets', { skip }, async () => {
  await seedPlayers();
  await pool.query(`INSERT INTO league_group (group_tag, season_id, tier_id) VALUES ('#G1', $1, ${MIN})`, [CUR]);
  assert.deepEqual((await repo.loadTargets('', 50)).map((t) => t.groupTag), ['#G5', '#G8']);
});
