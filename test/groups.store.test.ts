import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { APILeagueGroupList } from 'clashofclans.js';
import pg from 'pg';
import { GroupStore, parseApiTime } from '../src/groups/store.js';

const url = process.env['TEST_DATABASE_URL'];
const skip = url ? false : 'set TEST_DATABASE_URL to run';
const WEEK = 604_800;
const SEASON = '1792386000';
const ref = { groupTag: '#G1', seasonId: SEASON, tierId: 105000030 };
let pool: pg.Pool;
let store: GroupStore;

const m = (tag: string, clan: string | '', aw: number, al: number, dw = 0, dl = 0, name = `N${tag}`) => ({
  playerTag: tag, playerName: name, clanTag: clan, clanName: clan ? `Clan${clan}` : '', leagueTrophies: 5000,
  attackWinCount: aw, attackLoseCount: al, defenseWinCount: dw, defenseLoseCount: dl
});
const log = (opp: string, time: string, trophies: number, stars = 3, pct = 100) => ({
  opponentPlayerTag: opp, opponentName: opp, stars, destructionPercentage: pct, trophies, creationTime: time
});
const T1 = '20261024T061234.000Z';
const T2 = '20261024T071500.000Z';
const T3 = '20261025T010203.000Z';
const roster = (aName = 'NA') => [m('#A', '#C1', 2, 1, 0, 0, aName), m('#B', '#C1', 1, 2), m('#C', '#C2', 3, 0), m('#D', '', 0, 0)];
const asA = (aName?: string) =>
  ({ members: roster(aName), attackLogs: [log('#B', T1, 40), log('#C', T2, 32, 2, 80)], defenseLogs: [log('#C', T3, 8, 1, 40)] }) as unknown as APILeagueGroupList;
const asB = () =>
  ({ members: roster(), attackLogs: [log('#C', T3, 16, 2, 70)], defenseLogs: [log('#A', T1, 7)] }) as unknown as APILeagueGroupList;

before(async () => {
  if (!url) return;
  pool = new pg.Pool({ connectionString: url, max: 10 });
  for (const f of ['sql/002_profile_state.sql', 'sql/004_group_registration.sql']) await pool.query(readFileSync(f, 'utf8'));
  store = new GroupStore(pool, WEEK);
});
after(async () => void (await pool?.end()));
beforeEach(async () => {
  if (!url) return;
  await pool.query('TRUNCATE battle, group_fetch_state, group_member, player_season_result, player_name_history, league_group, season, player, clan CASCADE');
});

test('parseApiTime handles API and ISO timestamps', () => {
  assert.equal(parseApiTime('20261024T061234.000Z'), '2026-10-24T06:12:34.000Z');
  assert.equal(parseApiTime('20261024T061234Z'), '2026-10-24T06:12:34.000Z');
  assert.equal(parseApiTime('2026-10-24T06:12:34.000Z'), '2026-10-24T06:12:34.000Z');
  assert.throws(() => parseApiTime('nonsense'));
});

test('stores group, roster, clans, players, name history, battles and which member was logged', { skip }, async () => {
  const r = await store.store(ref, '#A', asA());
  assert.deepEqual(r, { membersWritten: 4, battlesInserted: 3, battleSidesFilled: 0, expectedBattles: 9 });

  const g = (await pool.query('SELECT tier_id, expected_battles, stored_battles, status FROM league_group')).rows[0];
  assert.deepEqual([Number(g.tier_id), g.expected_battles, g.stored_battles, g.status], [105000030, 9, 3, 'pending']);

  assert.equal(Number((await pool.query('SELECT count(*) AS n FROM group_member')).rows[0].n), 4);
  const logged = (await pool.query('SELECT player_tag, attacks_logged, defenses_logged, logs_fetched_at FROM group_member ORDER BY player_tag')).rows;
  assert.deepEqual(logged.map((x) => [x.player_tag, x.attacks_logged, x.defenses_logged, x.logs_fetched_at !== null]),
    [['#A', 2, 1, true], ['#B', null, null, false], ['#C', null, null, false], ['#D', null, null, false]]);
  assert.equal((await pool.query(`SELECT clan_tag FROM group_member WHERE player_tag = '#D'`)).rows[0].clan_tag, null, 'no clan -> null, not empty string');

  assert.deepEqual((await pool.query('SELECT clan_tag, name, members_crawled_at FROM clan ORDER BY 1')).rows,
    [{ clan_tag: '#C1', name: 'Clan#C1', members_crawled_at: null }, { clan_tag: '#C2', name: 'Clan#C2', members_crawled_at: null }]);
  assert.equal(Number((await pool.query('SELECT count(*) AS n FROM player')).rows[0].n), 4);
  assert.equal(Number((await pool.query('SELECT count(*) AS n FROM player_name_history')).rows[0].n), 4);

  const b = (await pool.query('SELECT attacker_tag, defender_tag, attacker_trophies, defender_trophies FROM battle ORDER BY attacker_tag, battle_time')).rows;
  assert.deepEqual(b.map((x) => [x.attacker_tag, x.defender_tag, x.attacker_trophies, x.defender_trophies]),
    [['#A', '#B', 40, null], ['#A', '#C', 32, null], ['#C', '#A', null, 8]]);
  assert.equal((await pool.query(`SELECT tableoid::regclass::text AS t FROM battle LIMIT 1`)).rows[0].t, `battle_${SEASON}`);

  const s = (await pool.query(`SELECT extract(epoch FROM ends_at - starts_at) AS len FROM season WHERE season_id = $1`, [SEASON])).rows[0];
  assert.equal(Number(s.len), WEEK);
});

test('the second sighting of a battle (from the other player) fills the other side and counts it once', { skip }, async () => {
  await store.store(ref, '#A', asA());
  const r = await store.store(ref, '#B', asB());
  assert.deepEqual([r.battlesInserted, r.battleSidesFilled], [1, 1]);
  const ab = (await pool.query(`SELECT attacker_trophies, defender_trophies FROM battle WHERE attacker_tag='#A' AND defender_tag='#B'`)).rows[0];
  assert.deepEqual(ab, { attacker_trophies: 40, defender_trophies: 7 });
  assert.equal((await pool.query('SELECT stored_battles FROM league_group')).rows[0].stored_battles, 4);
  const logged = (await pool.query(`SELECT player_tag FROM group_member WHERE logs_fetched_at IS NOT NULL ORDER BY 1`)).rows.map((x) => x.player_tag);
  assert.deepEqual(logged, ['#A', '#B']);
});

test('storing the same response twice writes no battles, roster rows or players', { skip }, async () => {
  await store.store(ref, '#A', asA());
  const x = async (sql: string) => (await pool.query(sql)).rows.map((r) => r.x).join(',');
  const before = [
    await x(`SELECT xmin::text AS x FROM battle ORDER BY attacker_tag, battle_time`),
    await x(`SELECT xmin::text AS x FROM group_member WHERE player_tag <> '#A' ORDER BY player_tag`),
    await x(`SELECT xmin::text AS x FROM player ORDER BY player_tag`),
    await x(`SELECT xmin::text AS x FROM clan ORDER BY clan_tag`)
  ];
  const r = await store.store(ref, '#A', asA());
  assert.deepEqual([r.membersWritten, r.battlesInserted, r.battleSidesFilled], [0, 0, 0]);
  const after_ = [
    await x(`SELECT xmin::text AS x FROM battle ORDER BY attacker_tag, battle_time`),
    await x(`SELECT xmin::text AS x FROM group_member WHERE player_tag <> '#A' ORDER BY player_tag`),
    await x(`SELECT xmin::text AS x FROM player ORDER BY player_tag`),
    await x(`SELECT xmin::text AS x FROM clan ORDER BY clan_tag`)
  ];
  assert.deepEqual(after_, before);
});

test('a renamed player is updated and both names stay in the history', { skip }, async () => {
  await store.store(ref, '#A', asA('Old'));
  await store.store(ref, '#A', asA('New'));
  assert.equal((await pool.query(`SELECT name FROM player WHERE player_tag = '#A'`)).rows[0].name, 'New');
  assert.deepEqual((await pool.query(`SELECT name FROM player_name_history WHERE player_tag = '#A' ORDER BY name`)).rows.map((r) => r.name), ['New', 'Old']);
});

test('roster stat changes are written; a duplicate battle inside one response is merged, not an error', { skip }, async () => {
  await store.store(ref, '#A', asA());
  const changed = { ...asA(), members: [m('#A', '#C1', 3, 1), m('#B', '#C1', 1, 2), m('#C', '#C2', 3, 0), m('#D', '', 0, 0)] } as unknown as APILeagueGroupList;
  assert.equal((await store.store(ref, '#A', changed)).membersWritten, 1);
  const dup = { members: roster(), attackLogs: [log('#B', T1, 40), log('#B', T1, 40)], defenseLogs: [] } as unknown as APILeagueGroupList;
  await store.store({ ...ref, groupTag: '#G2' }, '#A', dup);
});

test('concurrent stores of overlapping groups, with separate store instances racing to create a new season partition, do not fail', { skip }, async () => {
  const season = String(1792386000 - WEEK * 40);
  const stores = Array.from({ length: 4 }, () => new GroupStore(pool, WEEK));
  const jobs = Array.from({ length: 8 }, (_, i) => {
    const members = [m('#A', '#C1', 1, 0), m('#B', '#C1', 1, 0), m('#C', '#C2', 1, 0), m(`#X${i}`, `#CX${i % 3}`, 1, 0)];
    const res = { members: i % 2 ? [...members].reverse() : members, attackLogs: [log('#B', T1, 40), log(`#X${i}`, T2, 20)], defenseLogs: [] } as unknown as APILeagueGroupList;
    return (stores[i % 4] as GroupStore).store({ groupTag: `#GG${i}`, seasonId: season, tierId: 105000030 }, '#A', res);
  });
  await Promise.all(jobs);
  assert.equal(Number((await pool.query('SELECT count(*) AS n FROM league_group')).rows[0].n), 8);
  assert.equal(Number((await pool.query('SELECT count(*) AS n FROM player')).rows[0].n), 3 + 8);
});
