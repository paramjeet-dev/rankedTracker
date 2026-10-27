import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { APIClan } from 'clashofclans.js';
import type { CallResult } from '../src/shared/clash.js';
import type { DiscoveryPool, DiscoveryRepo, MemberRow } from '../src/discovery/repo.js';
import { PlayersDiscovery } from '../src/discovery/run.js';
import { createLogger } from '../src/shared/logger.js';

const quiet = { info() {}, warn() {}, error() {} } as ReturnType<typeof createLogger>;

function fakeRepo(all: string[]) {
  const done = new Set<string>();
  const calls = { saved: [] as string[], failed: [] as string[], invalid: [] as string[], pages: 0 };
  const repo: DiscoveryRepo = {
    async loadTargets(_p, after, limit) {
      calls.pages++;
      return all.filter((t) => t > after && !done.has(t)).slice(0, limit);
    },
    countTargets: async () => all.length - done.size,
    async saveClan(tag, _n, _m: MemberRow[]) {
      done.add(tag);
      calls.saved.push(tag);
      return { inserted: 2, tierUpdated: 1 };
    },
    async recordFailure(tag) {
      done.add(tag); // stands in for next_attempt_at moving into the future
      calls.failed.push(tag);
    },
    async markInvalid(tag) {
      done.add(tag);
      calls.invalid.push(tag);
    },
    tagFormatProblem: async () => null
  };
  return { repo, calls };
}

const clan = (tag: string): APIClan => ({ tag, name: `n${tag}`, memberList: [{ tag: '#P1', name: 'a', leagueTier: { id: 105000030 } }] }) as unknown as APIClan;
const ok = (v: APIClan): CallResult<APIClan> => ({ ok: true, value: v, attempts: 1 });
const fail = (kind: string, permanent: boolean): CallResult<APIClan> =>
  ({ ok: false, kind, permanent, message: kind, attempts: 1 }) as CallResult<APIClan>;

function make(all: string[], fetch: (tag: string) => CallResult<APIClan>, pageSize = 3) {
  const { repo, calls } = fakeRepo(all);
  const ac = new AbortController();
  const d = new PlayersDiscovery({
    repo,
    log: quiet,
    signal: ac.signal,
    pageSize,
    idleMs: { new: 5, refresh: 5 },
    fetchClan: async (_p: DiscoveryPool, tag) => fetch(tag)
  });
  return { d, calls, ac };
}

test('workers drain several pages and every clan is processed exactly once', async () => {
  const tags = Array.from({ length: 10 }, (_, i) => `#C${String(i).padStart(2, '0')}`);
  const { d, calls, ac } = make(tags, (t) => ok(clan(t)));
  const run = d.runPool('new', 4);
  while (calls.saved.length < 10) await new Promise((r) => setTimeout(r, 5));
  ac.abort();
  await run;
  assert.deepEqual([...calls.saved].sort(), tags);
  assert.equal(new Set(calls.saved).size, 10);
  assert.equal(d.stats.new.playersInserted, 20);
});

test('outages leave the clan untouched; 404 marks invalid; 500 backs off only that clan', async () => {
  const outcome: Record<string, CallResult<APIClan>> = {
    '#A': fail('unavailable', false),
    '#B': fail('not_found', true),
    '#C': fail('server', false),
    '#D': ok(clan('#D'))
  };
  const { d, calls } = make(['#A', '#B', '#C', '#D'], (t) => outcome[t] as CallResult<APIClan>);
  for (const t of ['#A', '#B', '#C', '#D']) await d.processClan('new', t);
  assert.deepEqual(calls.invalid, ['#B']);
  assert.deepEqual(calls.failed, ['#C']);
  assert.deepEqual(calls.saved, ['#D']);
  assert.equal(d.stats.new.skippedOutage, 1);
});

test('a database error in one clan does not kill the worker, and that clan is retried on the next pass', async () => {
  const { repo, calls } = fakeRepo(['#A', '#B']);
  let first = true;
  const orig = repo.saveClan.bind(repo);
  repo.saveClan = async (...a) => {
    if (first) {
      first = false;
      throw new Error('connection reset');
    }
    return orig(...a);
  };
  const ac = new AbortController();
  const d = new PlayersDiscovery({
    repo, log: quiet, signal: ac.signal, pageSize: 10, idleMs: { new: 5, refresh: 5 },
    fetchClan: async (_p, tag) => ok(clan(tag))
  });
  const run = d.runPool('new', 1);
  const deadline = Date.now() + 8_000;
  // the failed clan was never marked done, so it stays a target and succeeds on the following scan
  while (calls.saved.length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  ac.abort();
  await run;
  assert.equal(d.stats.new.dbErrors, 1);
  assert.deepEqual([...calls.saved].sort(), ['#A', '#B']);
});

test('an empty target set idles and wraps instead of spinning, and stops on abort', async () => {
  const { d, calls, ac } = make([], (t) => ok(clan(t)));
  const run = d.runPool('new', 2);
  await new Promise((r) => setTimeout(r, 40));
  ac.abort();
  await run;
  assert.ok(calls.pages >= 2 && calls.pages < 40, `pages=${calls.pages}`);
});
