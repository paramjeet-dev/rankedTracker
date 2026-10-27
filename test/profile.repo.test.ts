import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { PgProfileRepo, type ProfileData, type SeasonResultRow } from '../src/profile/repo.js';
import { seasonConventionProblem } from '../src/shared/sanity.js';

const url = process.env['TEST_DATABASE_URL'];
const skip = url ? false : 'set TEST_DATABASE_URL to run';
const MIN = 105000026;
const MAX = 105000033;
const WEEK = 604_800;
let pool: pg.Pool;
let repo: PgProfileRepo;

const nowSec = () => Math.floor(Date.now() / 1000);
/** Monday-05:00-style season boundary just before now, aligned to a 1-week grid anchored on a known season id. */
const ANCHOR = 1792386000;
const currentStart = () => ANCHOR + Math.floor((nowSec() - ANCHOR) / WEEK) * WEEK;

const profile = (over: Partial<ProfileData> = {}): ProfileData => ({
  tag: '#P1', name: 'New Name', clanTag: '#CL1', clanName: 'Clan One', tierId: MIN, currentGroupTag: '#G1', currentGroupSeasonId: String(currentStart()),
  previousGroupTag: '#G0', previousGroupSeasonId: String(currentStart() - WEEK), ...over
});
const result = (seasonId: string, over: Partial<SeasonResultRow> = {}): SeasonResultRow => ({
  seasonId, tierId: MIN, trophies: 5000, placement: 3, attackWins: 4, attackLosses: 1,
  defenseWins: 2, defenseLosses: 3, defenseStars: 9, maxBattles: 8, ...over
});

before(async () => {
  if (!url) return;
  pool = new pg.Pool({ connectionString: url, max: 6 });
  await pool.query(readFileSync('sql/002_profile_state.sql', 'utf8'));
  repo = new PgProfileRepo(pool, { minTier: MIN, maxTier: MAX, seasonSeconds: WEEK });
});
after(async () => void (await pool?.end()));
beforeEach(async () => {
  if (!url) return;
  await pool.query('TRUNCATE group_member, player_season_result, player_name_history, league_group, season, player, clan CASCADE');
  await pool.query(`INSERT INTO season (season_id, starts_at, ends_at) SELECT x.s, to_timestamp(x.s::bigint), to_timestamp(x.s::bigint + $2) FROM (SELECT $1::text AS s) x`, [String(ANCHOR), WEEK]);
});

test('migration 002 is idempotent', { skip }, async () => {
  await pool.query(readFileSync('sql/002_profile_state.sql', 'utf8'));
  await pool.query(readFileSync('sql/002_profile_state.sql', 'utf8'));
});

test('new pool: never-visited, in-scope or unknown tier, not invalid, not backed off; ordered with a cursor', { skip }, async () => {
  await pool.query(`INSERT INTO player (player_tag, tier_id, invalid_at, next_attempt_at, history_backfilled_at) VALUES
    ('#N1', NULL, NULL, NULL, NULL), ('#N2', ${MIN}, NULL, NULL, NULL), ('#N3', 105000036, NULL, NULL, NULL),
    ('#N4', ${MAX}, now(), NULL, NULL), ('#N5', ${MAX}, NULL, now() + interval '1 hour', NULL), ('#N6', ${MAX}, NULL, NULL, now()),
    ('#N7', ${MAX}, NULL, now() - interval '1 hour', NULL)`);
  assert.deepEqual(await repo.loadTargets('new', '', 10), ['#N1', '#N2', '#N7']);
  assert.deepEqual(await repo.loadTargets('new', '#N1', 1), ['#N2']);
  assert.equal(await repo.countTargets('new'), 3);
});

test('refresh pool: visited before the current season started, tier in scope', { skip }, async () => {
  const before = `to_timestamp(${currentStart() - 3600})`;
  const after_ = `to_timestamp(${currentStart() + 3600})`;
  await pool.query(`INSERT INTO player (player_tag, tier_id, history_backfilled_at) VALUES
    ('#R1', ${MIN}, ${before}), ('#R2', ${MIN}, ${after_}), ('#R3', NULL, NULL), ('#R4', 105000036, ${before})`);
  assert.deepEqual(await repo.loadTargets('refresh', '', 10), ['#R1']);
  assert.equal(await repo.countTargets('refresh'), 1);
  assert.deepEqual(await repo.loadTargets('new', '', 10), ['#R3']);
});

test('saveVisit writes profile, clan, name history (old and new), season rows and results', { skip }, async () => {
  await pool.query(`INSERT INTO player (player_tag, name) VALUES ('#P1', 'Old Name')`);
  const s1 = String(ANCHOR - WEEK * 3);
  const s2 = String(ANCHOR - WEEK * 2);
  const r = await repo.saveVisit(profile(), [result(s1), result(s2, { tierId: MIN + 2, placement: 1 })]);
  assert.deepEqual(r, { updated: true, nameChanged: true, resultsWritten: 2 });

  const p = (await pool.query('SELECT * FROM player WHERE player_tag = $1', ['#P1'])).rows[0];
  assert.equal(p.name, 'New Name');
  assert.equal(Number(p.tier_id), MIN);
  assert.ok(p.profiled_at && p.history_backfilled_at);
  assert.equal(p.current_group_tag, '#G1');
  assert.equal(p.previous_group_tag, '#G0');
  assert.equal(p.fail_count, 0);

  const names = (await pool.query(`SELECT name FROM player_name_history WHERE player_tag='#P1' ORDER BY name`)).rows.map((x) => x.name);
  assert.deepEqual(names, ['New Name', 'Old Name']);

  const seasons = (await pool.query(`SELECT season_id, extract(epoch FROM ends_at - starts_at) AS len FROM season WHERE season_id IN ($1,$2) ORDER BY 1`, [s1, s2])).rows;
  assert.equal(seasons.length, 2);
  assert.ok(seasons.every((x) => Number(x.len) === WEEK));

  const rows = (await pool.query('SELECT season_id, placement FROM player_season_result ORDER BY season_id')).rows;
  assert.deepEqual(rows.map((x) => [x.season_id, x.placement]), [[s1, 3], [s2, 1]]);
  const clan = (await pool.query(`SELECT name, members_crawled_at FROM clan WHERE clan_tag = '#CL1'`)).rows[0];
  assert.deepEqual(clan, { name: 'Clan One', members_crawled_at: null }, 'a new clan enters the catalogue uncrawled');
});

test('re-saving an identical visit rewrites no result rows; a corrected value is applied', { skip }, async () => {
  await pool.query(`INSERT INTO player (player_tag, name) VALUES ('#P1', 'Same')`);
  const s = String(ANCHOR - WEEK);
  const first = await repo.saveVisit(profile({ name: 'Same' }), [result(s)]);
  assert.equal(first.resultsWritten, 1);
  const x1 = (await pool.query(`SELECT xmin::text AS x FROM player_season_result WHERE season_id=$1`, [s])).rows[0].x;
  const second = await repo.saveVisit(profile({ name: 'Same' }), [result(s)]);
  assert.equal(second.resultsWritten, 0);
  assert.equal(second.nameChanged, false);
  assert.equal((await pool.query(`SELECT xmin::text AS x FROM player_season_result WHERE season_id=$1`, [s])).rows[0].x, x1);
  const third = await repo.saveVisit(profile({ name: 'Same' }), [result(s, { placement: 2 })]);
  assert.equal(third.resultsWritten, 1);
});

test('an existing clan keeps its crawl state; only a changed name is written', { skip }, async () => {
  await pool.query(`INSERT INTO clan (clan_tag, name, members_crawled_at) VALUES ('#CL1', 'Clan One', now() - interval '1 day')`);
  await pool.query(`INSERT INTO player (player_tag, name) VALUES ('#P1', 'x')`);
  const x1 = (await pool.query(`SELECT xmin::text AS x FROM clan WHERE clan_tag='#CL1'`)).rows[0].x;
  await repo.saveVisit(profile(), []);
  assert.equal((await pool.query(`SELECT xmin::text AS x FROM clan WHERE clan_tag='#CL1'`)).rows[0].x, x1, 'same name: no write');
  await repo.saveVisit(profile({ clanName: 'Renamed' }), []);
  const c = (await pool.query(`SELECT name, members_crawled_at FROM clan WHERE clan_tag='#CL1'`)).rows[0];
  assert.equal(c.name, 'Renamed');
  assert.ok(c.members_crawled_at, 'crawl state untouched');
});

test('a player without a clan is saved without touching clan', { skip }, async () => {
  await pool.query(`INSERT INTO player (player_tag, name) VALUES ('#P1', 'x')`);
  await repo.saveVisit(profile({ clanTag: null, clanName: null }), []);
  assert.equal(Number((await pool.query('SELECT count(*) AS n FROM clan')).rows[0].n), 0);
});

test('migration 003 removes a leftover attack_stars column and is idempotent', { skip }, async () => {
  await pool.query('ALTER TABLE player_season_result ADD COLUMN IF NOT EXISTS attack_stars integer');
  await pool.query(readFileSync('sql/003_drop_attack_stars.sql', 'utf8'));
  await pool.query(readFileSync('sql/003_drop_attack_stars.sql', 'utf8'));
  const cols = (await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name='player_season_result' AND column_name='attack_stars'`)).rowCount;
  assert.equal(cols, 0);
});

test('empty group tags are stored as null; unknown players are ignored', { skip }, async () => {
  await pool.query(`INSERT INTO player (player_tag) VALUES ('#P1')`);
  await repo.saveVisit(profile({ currentGroupTag: null, currentGroupSeasonId: null, previousGroupTag: null, previousGroupSeasonId: null }), []);
  const p = (await pool.query(`SELECT current_group_tag, previous_group_season_id FROM player WHERE player_tag='#P1'`)).rows[0];
  assert.deepEqual(p, { current_group_tag: null, previous_group_season_id: null });
  assert.deepEqual(await repo.saveVisit(profile({ tag: '#NOPE' }), []), { updated: false, nameChanged: false, resultsWritten: 0 });
});

test('concurrent visits that share seasons do not deadlock', { skip }, async () => {
  const tags = Array.from({ length: 8 }, (_, i) => `#C${i}`);
  await pool.query(`INSERT INTO player (player_tag) SELECT unnest($1::text[])`, [tags]);
  const seasons = Array.from({ length: 12 }, (_, i) => String(ANCHOR - WEEK * (i + 1)));
  await Promise.all(tags.map((t, i) => repo.saveVisit(profile({ tag: t, name: t }), (i % 2 ? [...seasons].reverse() : seasons).map((s) => result(s)))));
  assert.equal(Number((await pool.query('SELECT count(*) AS n FROM player_season_result')).rows[0].n), 8 * 12);
  assert.equal(Number((await pool.query('SELECT count(*) AS n FROM season')).rows[0].n), 13);
});

test('failure backoff and invalid', { skip }, async () => {
  await pool.query(`INSERT INTO player (player_tag) VALUES ('#F1'), ('#F2')`);
  await repo.recordFailure('#F1');
  await repo.markInvalid('#F2');
  assert.deepEqual(await repo.loadTargets('new', '', 10), []);
  assert.equal((await pool.query(`SELECT fail_count FROM player WHERE player_tag='#F1'`)).rows[0].fail_count, 1);
});

test('season convention check flags rows that are not "id = start, one week long"', { skip }, async () => {
  assert.equal(await seasonConventionProblem(pool, WEEK), null);
  await pool.query(`INSERT INTO season (season_id, starts_at, ends_at) VALUES ('1000000000', to_timestamp(1000000000 + 604800), to_timestamp(1000000000 + 1209600))`);
  assert.match((await seasonConventionProblem(pool, WEEK)) ?? '', /does not match/);
});
