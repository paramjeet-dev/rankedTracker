import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { APILeagueGroupList } from 'clashofclans.js';
import type { BattlesRepo, CollectTarget, GroupStatus } from '../src/battles/repo.js';
import { BattleCollector } from '../src/battles/run.js';
import type { CallResult } from '../src/shared/clash.js';

const quiet = { info() {}, warn() {}, error() {} };
const T: CollectTarget = { groupTag: '#G1', seasonId: '1791781200', tierId: 105000030 };
const okRes = (): CallResult<APILeagueGroupList> => ({ ok: true, value: { members: [], attackLogs: [], defenseLogs: [] }, attempts: 1 });
const fail = (kind: string, permanent: boolean): CallResult<APILeagueGroupList> =>
  ({ ok: false, kind, permanent, message: kind, attempts: 1 }) as CallResult<APILeagueGroupList>;

function rig(members: string[], answer: (m: string) => CallResult<APILeagueGroupList>, coveredAfter = Infinity) {
  const state = { fetched: [] as string[], finalized: 0, failures: 0, stored: 0, begun: 0, aborted: false };
  const repo: BattlesRepo = {
    loadTargets: async () => [],
    countTargets: async () => 0,
    beginGroup: async () => void state.begun++,
    nextMember: async (_t, visited) => members.find((m) => !visited.includes(m)) ?? null,
    isCovered: async () => state.stored >= coveredAfter,
    finalize: async () => (state.finalized++, (state.stored >= coveredAfter ? 'complete' : 'incomplete') as GroupStatus),
    recordFailure: async () => void state.failures++,
    sanityProblem: async () => null
  };
  const ac = new AbortController();
  const c = new BattleCollector({
    repo, log: quiet, signal: ac.signal, pageSize: 10, idleMs: 5,
    store: { store: async () => (state.stored++, { membersWritten: 0, battlesInserted: 2, battleSidesFilled: 0, expectedBattles: 9 }) },
    fetchGroup: async (_t, m) => (state.fetched.push(m), answer(m))
  });
  return { c, state, ac };
}

test('stops as soon as the group is covered and settles it once', async () => {
  const r = rig(['#A', '#B', '#C', '#D', '#E'], () => okRes(), 3);
  assert.equal(await r.c.processGroup(T), 'complete');
  assert.deepEqual(r.state.fetched, ['#A', '#B', '#C']);
  assert.equal(r.state.finalized, 1);
  assert.equal(r.c.stats.complete, 1);
  assert.equal(r.c.stats.battlesInserted, 6);
});

test('visits every member when the group never gets covered, then settles it as incomplete', async () => {
  const r = rig(['#A', '#B', '#C'], () => okRes());
  assert.equal(await r.c.processGroup(T), 'incomplete');
  assert.deepEqual(r.state.fetched, ['#A', '#B', '#C']);
});

test('an outage pauses the group: nothing is settled and it stays a target', async () => {
  const r = rig(['#A', '#B'], (m) => (m === '#B' ? fail('unavailable', false) : okRes()));
  assert.equal(await r.c.processGroup(T), null);
  assert.equal(r.state.finalized, 0);
  assert.equal(r.c.stats.paused, 1);
});

test('a transient failure backs the group off without settling it', async () => {
  const r = rig(['#A', '#B'], (m) => (m === '#A' ? fail('server', false) : okRes()));
  assert.equal(await r.c.processGroup(T), null);
  assert.deepEqual([r.state.failures, r.state.finalized, r.c.stats.failed], [1, 0, 1]);
});

test('a permanent error skips that member and carries on', async () => {
  const r = rig(['#A', '#B', '#C'], (m) => (m === '#A' ? fail('forbidden', true) : okRes()), 2);
  assert.equal(await r.c.processGroup(T), 'complete');
  assert.deepEqual(r.state.fetched, ['#A', '#B', '#C']);
});

test('three not-found answers in a row mean the group is no longer served: stop early, settle as incomplete', async () => {
  const r = rig(Array.from({ length: 50 }, (_, i) => `#M${i}`), () => fail('not_found', true));
  assert.equal(await r.c.processGroup(T), 'incomplete');
  assert.equal(r.state.fetched.length, 3, 'does not spend a call on every member');
});

test('a success resets the not-found streak', async () => {
  const seq = ['not_found', 'not_found', 'ok', 'not_found', 'not_found', 'ok'];
  let i = 0;
  const r = rig(['#A', '#B', '#C', '#D', '#E', '#F'], () => (seq[i++] === 'ok' ? okRes() : fail('not_found', true)));
  assert.equal(await r.c.processGroup(T), 'incomplete');
  assert.equal(r.state.fetched.length, 6);
});

test('the same group is never collected twice at once', async () => {
  let release!: () => void;
  const gate = new Promise<void>((res) => (release = res));
  const r = rig(['#A'], () => okRes());
  const slowFetch = r.c as unknown as { d: { fetchGroup: unknown } };
  slowFetch.d.fetchGroup = async () => (await gate, okRes());
  const first = r.c.processGroup(T);
  await new Promise((x) => setImmediate(x));
  assert.equal(await r.c.processGroup(T), null, 'second offer is ignored while the first runs');
  release();
  assert.equal(await first, 'incomplete');
});

test('abort stops mid-group without settling it', async () => {
  const r = rig(['#A', '#B', '#C'], () => okRes());
  r.ac.abort();
  assert.equal(await r.c.processGroup(T), null);
  assert.equal(r.state.finalized, 0);
});
