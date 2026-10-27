import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { APILeagueGroupList } from 'clashofclans.js';
import pg from 'pg';
import { collectCursor, PgBattlesRepo } from '../src/battles/repo.js';
import { BattleCollector } from '../src/battles/run.js';
import { GroupStore } from '../src/groups/store.js';
import type { CallResult } from '../src/shared/clash.js';

const url = process.env['TEST_DATABASE_URL'];
const skip = url ? false : 'set TEST_DATABASE_URL to run';
const MIN = 105000026;
const MAX = 105000033;
const WEEK = 604_800;
const now = () => Math.floor(Date.now() / 1000);
let pool: pg.Pool;
let repo: PgBattlesRepo;
const quiet = { info() {}, warn() {}, error() {} };

/** A season id whose season ended `minutesAgo` minutes ago. */
const endedAgo = (minutesAgo: number) => String(now() - WEEK - minutesAgo * 60);

before(async () => {
  if (!url) return;
  pool = new pg.Pool({ connectionString: url, max: 10 });
  for (const f of ['sql/002_profile_state.sql', 'sql/004_group_registration.sql', 'sql/005_battle_collection.sql']) {
    await pool.query(readFileSync(f, 'utf8'));
  }
  repo = new PgBattlesRepo(pool, { minTier: MIN, maxTier: MAX, seasonSeconds: WEEK });
});
after(async () => void (await pool?.end()));
beforeEach(async () => {
  if (!url) return;
  await pool.query('TRUNCATE battle, group_fetch_state, group_member, player_season_result, player_name_history, league_group, season, player, clan CASCADE');
});

const addSeason = (id: string) =>
  pool.query(`INSERT INTO season (season_id, starts_at, ends_at) SELECT x.s, to_timestamp(x.s::bigint), to_timestamp(x.s::bigint + $2) FROM (SELECT $1::text AS s) x ON CONFLICT DO NOTHING`, [id, WEEK]);
const addGroup = async (g: string, season: string, over: Partial<{ tier: number; status: string; collected: boolean; backoff: string; expected: number }> = {}) => {
  await addSeason(season);
  await pool.query(
    `INSERT INTO league_group (group_tag, season_id, tier_id, expected_battles, status, collected_at, collect_next_attempt_at)
     VALUES ($1, $2, $3, $4, $5, ${over.collected ? 'now()' : 'NULL'}, ${over.backoff ? `now() + interval '${over.backoff}'` : 'NULL'})`,
    [g, season, over.tier ?? MIN, over.expected ?? 5, over.status ?? 'pending']
  );
};

test('migration 005 is idempotent and backfills groups the old crawler already settled', { skip }, async () => {
  await addGroup('#OLDC', endedAgo(60), { status: 'complete' });
  await addGroup('#OLDI', endedAgo(60), { status: 'incomplete' });
  await addGroup('#OPEN', endedAgo(60), { status: 'pending' });
  await pool.query(`UPDATE league_group SET collected_at = NULL`);
  await pool.query(readFileSync('sql/005_battle_collection.sql', 'utf8'));
  await pool.query(readFileSync('sql/005_battle_collection.sql', 'utf8'));
  const r = (await pool.query('SELECT group_tag, collected_at IS NOT NULL AS c FROM league_group ORDER BY 1')).rows;
  assert.deepEqual(r.map((x) => [x.group_tag, x.c]), [['#OLDC', true], ['#OLDI', true], ['#OPEN', false]]);
});

test('targets: season ended more than 10 minutes ago, in scope, unsettled, not backing off; newest season first', { skip }, async () => {
  const s11 = endedAgo(11);
  const s5 = endedAgo(5);
  const old = endedAgo(60 * 24 * 8);
  await addGroup('#OK1', s11);
  await addGroup('#OK2', s11);
  await addGroup('#OLD', old);
  await addGroup('#TOOSOON', s5);
  await addGroup('#LEGEND', s11, { tier: 105000036 });
  await addGroup('#DONE', s11, { status: 'complete' });
  await addGroup('#SETTLED', s11, { status: 'incomplete', collected: true });
  await addGroup('#BACKOFF', s11, { backoff: '1 hour' });
  await addGroup('#RUNNING', String(now() - 3600)); // season still running
  const all = await repo.loadTargets('', 50);
  assert.deepEqual(all.map((t) => t.groupTag), ['#OK2', '#OK1', '#OLD']);
  assert.equal(await repo.countTargets(), 3);
  const first = await repo.loadTargets('', 2);
  assert.deepEqual((await repo.loadTargets(collectCursor(first[1]!), 5)).map((t) => t.groupTag), ['#OLD']);
});

test('beginGroup stamps season.swept_at once', { skip }, async () => {
  const s = endedAgo(30);
  await addGroup('#G', s);
  await repo.beginGroup({ groupTag: '#G', seasonId: s, tierId: MIN });
  const first = (await pool.query('SELECT swept_at FROM season WHERE season_id = $1', [s])).rows[0].swept_at;
  assert.ok(first);
  await repo.beginGroup({ groupTag: '#G', seasonId: s, tierId: MIN });
  assert.deepEqual((await pool.query('SELECT swept_at FROM season WHERE season_id = $1', [s])).rows[0].swept_at, first);
});

// --- end to end: real store and repo, simulated API ---------------------------------------------------------------
type Battle = { att: string; def: string; time: string; atro: number; dtro: number };
const times = ['20261010T010101.000Z', '20261010T020202.000Z', '20261010T030303.000Z', '20261010T040404.000Z', '20261010T050505.000Z'];

/** Six players: every battle is in two logs. Activity (attacks + defenses): A,B,C,E = 2, D,F = 1. */
const BATTLES: Battle[] = [
  { att: '#A', def: '#B', time: times[0]!, atro: 40, dtro: 0 },
  { att: '#A', def: '#C', time: times[1]!, atro: 30, dtro: 10 },
  { att: '#B', def: '#C', time: times[2]!, atro: 20, dtro: 20 },
  { att: '#D', def: '#E', time: times[3]!, atro: 40, dtro: 0 },
  { att: '#E', def: '#F', time: times[4]!, atro: 25, dtro: 15 }
];
const PLAYERS = ['#A', '#B', '#C', '#D', '#E', '#F'];
function respond(member: string): APILeagueGroupList {
  const members = PLAYERS.map((p) => {
    const attacks = BATTLES.filter((b) => b.att === p).length;
    const defenses = BATTLES.filter((b) => b.def === p).length;
    return { playerTag: p, playerName: `N${p}`, clanTag: '#CL', clanName: 'Clan', leagueTrophies: 5000, attackWinCount: attacks, attackLoseCount: 0, defenseWinCount: defenses, defenseLoseCount: 0 };
  });
  const entry = (opp: string, b: Battle, trophies: number) => ({ opponentPlayerTag: opp, opponentName: opp, stars: 3, destructionPercentage: 100, trophies, creationTime: b.time });
  return {
    members,
    attackLogs: BATTLES.filter((b) => b.att === member).map((b) => entry(b.def, b, b.atro)),
    defenseLogs: BATTLES.filter((b) => b.def === member).map((b) => entry(b.att, b, b.dtro))
  } as unknown as APILeagueGroupList;
}
const ok = (v: APILeagueGroupList): CallResult<APILeagueGroupList> => ({ ok: true, value: v, attempts: 1 });

function collector(answer: (m: string) => CallResult<APILeagueGroupList>, called: string[]) {
  const ac = new AbortController();
  return new BattleCollector({
    repo, log: quiet, signal: ac.signal, pageSize: 10, idleMs: 5,
    store: new GroupStore(pool, WEEK),
    fetchGroup: async (_t, m) => (called.push(m), answer(m))
  });
}

test('end to end: registers with one member, collects most-active-first and stops as soon as every battle is stored', { skip }, async () => {
  const season = endedAgo(30);
  const ref = { groupTag: '#G1', seasonId: season, tierId: MIN };
  await new GroupStore(pool, WEEK).store(ref, '#F', respond('#F')); // what `groups` does: roster + one member's logs
  assert.equal((await pool.query('SELECT stored_battles, expected_battles FROM league_group')).rows[0].stored_battles, 1);

  const called: string[] = [];
  const status = await collector((m) => ok(respond(m)), called).processGroup({ ...ref });
  assert.equal(status, 'complete');
  // F was fetched at registration after the season ended (fresh), so it is skipped; then A,B,C,E by activity and tag
  // A,B,C cover 3 battles, F already gave E->F, E gives D->E: 5 of 5, D is never fetched.
  assert.deepEqual(called, ['#A', '#B', '#C', '#E']);
  const g = (await pool.query('SELECT status, stored_battles, expected_battles, collected_at FROM league_group')).rows[0];
  assert.deepEqual([g.status, g.stored_battles, g.expected_battles, g.collected_at !== null], ['complete', 5, 5, true]);
  // Stopping once every battle is stored means D was never fetched: its battle D->E has only E's (defender) trophy
  // value. battle_resolved derives the missing side from the game's rules, exactly as before.
  const oneSided = (await pool.query('SELECT attacker_tag, attacker_trophies, defender_trophies FROM battle WHERE attacker_trophies IS NULL OR defender_trophies IS NULL')).rows;
  assert.deepEqual(oneSided, [{ attacker_tag: '#D', attacker_trophies: null, defender_trophies: 0 }]);
  assert.equal(Number((await pool.query('SELECT count(*) AS n FROM battle')).rows[0].n), 5);
  assert.equal((await pool.query(`SELECT logs_fetched_at FROM group_member WHERE player_tag = '#D'`)).rows[0].logs_fetched_at, null);
  assert.deepEqual(await repo.loadTargets('', 10), [], 'a settled group is no longer a target');
});

test('end to end: members whose logs are missing leave the group incomplete after the streak of not-found answers', { skip }, async () => {
  const season = endedAgo(30);
  const ref = { groupTag: '#G2', seasonId: season, tierId: MIN };
  await new GroupStore(pool, WEEK).store(ref, '#F', respond('#F'));
  const called: string[] = [];
  const status = await collector(() => ({ ok: false, kind: 'not_found', permanent: true, message: 'x', attempts: 1 }) as CallResult<APILeagueGroupList>, called).processGroup({ ...ref });
  assert.equal(status, 'incomplete');
  assert.equal(called.length, 3);
  assert.equal((await pool.query('SELECT status FROM league_group')).rows[0].status, 'incomplete');
});

test('end to end: a transient failure resumes later with only the members still missing', { skip }, async () => {
  const season = endedAgo(30);
  const ref = { groupTag: '#G3', seasonId: season, tierId: MIN };
  await new GroupStore(pool, WEEK).store(ref, '#F', respond('#F'));

  const firstCalls: string[] = [];
  const first = await collector((m) => (m === '#B' ? ({ ok: false, kind: 'server', permanent: false, message: 'x', attempts: 4 } as CallResult<APILeagueGroupList>) : ok(respond(m))), firstCalls).processGroup({ ...ref });
  assert.equal(first, null);
  assert.deepEqual(firstCalls, ['#A', '#B']);
  const g1 = (await pool.query('SELECT status, collected_at, collect_fail_count, collect_next_attempt_at > now() AS later FROM league_group')).rows[0];
  assert.deepEqual([g1.status, g1.collected_at, g1.collect_fail_count, g1.later], ['pending', null, 1, true]);
  assert.deepEqual(await repo.loadTargets('', 10), [], 'backing off');

  await pool.query('UPDATE league_group SET collect_next_attempt_at = NULL');
  const secondCalls: string[] = [];
  const second = await collector((m) => ok(respond(m)), secondCalls).processGroup({ ...ref });
  assert.equal(second, 'complete');
  assert.ok(!secondCalls.includes('#A'), 'A was already collected and is not fetched again');
  assert.equal((await pool.query('SELECT collect_fail_count FROM league_group')).rows[0].collect_fail_count, 0);
});
