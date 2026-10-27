import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { APILeagueGroupList } from 'clashofclans.js';
import type { CallResult } from '../src/shared/clash.js';
import { GroupsRegistrar } from '../src/groups/run.js';
import type { GroupTarget, GroupsRepo } from '../src/groups/repo.js';
import { targetCursor } from '../src/groups/repo.js';
import type { StoreResult } from '../src/groups/store.js';

const quiet = { info() {}, warn() {}, error() {} };
const target = (g: string, s = '1792386000'): GroupTarget => ({ groupTag: g, seasonId: s, playerTag: `#P-${g}`, tierId: 105000030 });
const stored: StoreResult = { membersWritten: 3, battlesInserted: 5, battleSidesFilled: 1, expectedBattles: 9 };
const okRes = (): CallResult<APILeagueGroupList> => ({ ok: true, value: { members: [], attackLogs: [], defenseLogs: [] }, attempts: 1 });
const fail = (kind: string, permanent: boolean): CallResult<APILeagueGroupList> =>
  ({ ok: false, kind, permanent, message: kind, attempts: 1 }) as CallResult<APILeagueGroupList>;

function rig(all: GroupTarget[], fetch: (t: GroupTarget) => CallResult<APILeagueGroupList>) {
  const done = new Set<string>();
  const calls = { stored: [] as string[], gone: [] as string[], failed: [] as string[] };
  const repo: GroupsRepo = {
    async loadTargets(after, limit) {
      return all.filter((t) => targetCursor(t) > after && !done.has(targetCursor(t))).slice(0, limit);
    },
    countTargets: async () => all.length - done.size,
    recordFailure: async (t) => (done.add(targetCursor(t)), void calls.failed.push(t.groupTag)),
    markGone: async (t) => (done.add(targetCursor(t)), void calls.gone.push(t.groupTag)),
    sanityProblem: async () => null
  };
  const ac = new AbortController();
  const g = new GroupsRegistrar({
    repo, log: quiet, signal: ac.signal, pageSize: 2, idleMs: 5,
    store: { store: async (ref) => (done.add(`${ref.groupTag}\u0001${ref.seasonId}`), calls.stored.push(ref.groupTag), stored) },
    fetchGroup: async (t) => fetch(t)
  });
  return { g, calls, ac };
}

test('workers register every group once, across pages, using the target player', async () => {
  const all = ['#A', '#B', '#C', '#D', '#E'].map((x) => target(x));
  const seen: string[] = [];
  const r = rig(all, (t) => (seen.push(t.playerTag), okRes()));
  const run = r.g.run(3);
  while (r.calls.stored.length < 5) await new Promise((x) => setTimeout(x, 5));
  r.ac.abort();
  await run;
  assert.deepEqual([...r.calls.stored].sort(), ['#A', '#B', '#C', '#D', '#E']);
  assert.deepEqual([...seen].sort(), all.map((t) => t.playerTag).sort());
  assert.equal(r.g.stats.battlesInserted, 25);
});

test('404 marks the group gone, 500 backs it off, outages touch nothing', async () => {
  const out: Record<string, CallResult<APILeagueGroupList>> = {
    '#A': fail('not_found', true), '#B': fail('server', false), '#C': fail('unavailable', false), '#D': okRes()
  };
  const r = rig(['#A', '#B', '#C', '#D'].map((x) => target(x)), (t) => out[t.groupTag] as CallResult<APILeagueGroupList>);
  for (const x of ['#A', '#B', '#C', '#D']) await r.g.processTarget(target(x));
  assert.deepEqual([r.calls.gone, r.calls.failed, r.calls.stored], [['#A'], ['#B'], ['#D']]);
  assert.equal(r.g.stats.skippedOutage, 1);
});

test('cursor is composite: the same group in two seasons is two targets', () => {
  assert.notEqual(targetCursor(target('#A', '1')), targetCursor(target('#A', '2')));
  assert.ok(targetCursor(target('#A', '1')) < targetCursor(target('#A', '2')));
});
