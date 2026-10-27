import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { APILeagueSeasonResultList, APIPlayer } from 'clashofclans.js';
import type { CallResult } from '../src/shared/clash.js';
import type { ProfileData, ProfilePool, ProfileRepo, SeasonResultRow } from '../src/profile/repo.js';
import { PlayersProfile } from '../src/profile/run.js';

const quiet = { info() {}, warn() {}, error() {} };
const MIN = 105000026;
const MAX = 105000033;

const okRes = <T,>(v: T): CallResult<T> => ({ ok: true, value: v, attempts: 1 });
const failRes = <T,>(kind: string, permanent: boolean): CallResult<T> => ({ ok: false, kind, permanent, message: kind, attempts: 1 }) as CallResult<T>;
const player = (over: Partial<APIPlayer> = {}): APIPlayer =>
  ({ name: 'Zed', tag: '#P1', clan: { tag: '#CL1', name: 'Clan One' }, leagueTier: { id: MIN + 1 }, currentLeagueGroupTag: '#G1', currentLeagueSeasonId: 1792386000, previousLeagueGroupTag: '', previousLeagueSeasonId: 0, ...over }) as unknown as APIPlayer;
const season = (id: number, tier: number) => ({ leagueSeasonId: id, leagueTierId: tier, leagueTrophies: 5000, placement: 3, attackWins: 4, attackLosses: 1, defenseWins: 2, defenseLosses: 3, defenseStars: 9, maxBattles: 8 });

function rig(opts: { player?: CallResult<APIPlayer>; history?: CallResult<APILeagueSeasonResultList>; scopeOnly?: boolean }) {
  const saved: Array<{ profile: ProfileData; results: SeasonResultRow[] }> = [];
  const calls = { failed: [] as string[], invalid: [] as string[], history: 0 };
  const repo: ProfileRepo = {
    loadTargets: async () => [],
    countTargets: async () => 0,
    saveVisit: async (profile, results) => (saved.push({ profile, results }), { updated: true, nameChanged: false, resultsWritten: results.length }),
    recordFailure: async (t) => void calls.failed.push(t),
    markInvalid: async (t) => void calls.invalid.push(t),
    sanityProblem: async () => null
  };
  const d = new PlayersProfile({
    repo, log: quiet, signal: new AbortController().signal, pageSize: 10, idleMs: { new: 5, refresh: 5 },
    scope: { minTier: MIN, maxTier: MAX, historyScopeOnly: opts.scopeOnly ?? true },
    fetchPlayer: async (_p: ProfilePool) => opts.player ?? okRes(player()),
    fetchHistory: async () => (calls.history++, opts.history ?? okRes({ items: [] } as APILeagueSeasonResultList))
  });
  return { d, saved, calls };
}

test('maps profile fields (including the clan), normalises empty group tags to null, converts season ids to text', async () => {
  const r = rig({});
  await r.d.processPlayer('new', '#P1');
  assert.deepEqual(r.saved[0]?.profile, {
    tag: '#P1', name: 'Zed', clanTag: '#CL1', clanName: 'Clan One', tierId: MIN + 1, currentGroupTag: '#G1', currentGroupSeasonId: '1792386000',
    previousGroupTag: null, previousGroupSeasonId: null
  });
});

test('history keeps only tracked tiers by default, and everything when scopeOnly is off', async () => {
  const items = [season(100, MIN), season(200, 105000036), season(300, 105000010), season(400, MAX)];
  const a = rig({ history: okRes({ items } as APILeagueSeasonResultList) });
  await a.d.processPlayer('new', '#P1');
  assert.deepEqual(a.saved[0]?.results.map((x) => x.seasonId), ['100', '400']);
  const b = rig({ history: okRes({ items } as APILeagueSeasonResultList), scopeOnly: false });
  await b.d.processPlayer('new', '#P1');
  assert.equal(b.saved[0]?.results.length, 4);
});

test('nothing is saved when the history call fails transiently; the player stays a target with backoff', async () => {
  const r = rig({ history: failRes('server', false) });
  await r.d.processPlayer('new', '#P1');
  assert.equal(r.saved.length, 0);
  assert.deepEqual(r.calls.failed, ['#P1']);
});

test('history 404 means no league history: the visit still completes', async () => {
  const r = rig({ history: failRes('not_found', true) });
  await r.d.processPlayer('new', '#P1');
  assert.equal(r.saved.length, 1);
  assert.deepEqual(r.saved[0]?.results, []);
});

test('player 404 marks invalid and never calls history; outages touch nothing', async () => {
  const gone = rig({ player: failRes('not_found', true) });
  await gone.d.processPlayer('new', '#P1');
  assert.deepEqual(gone.calls.invalid, ['#P1']);
  assert.equal(gone.calls.history, 0);
  const down = rig({ player: failRes('unavailable', false) });
  await down.d.processPlayer('new', '#P1');
  assert.deepEqual([down.calls.invalid, down.calls.failed, down.saved], [[], [], []]);
  assert.equal(down.d.stats.new.skippedOutage, 1);
});
