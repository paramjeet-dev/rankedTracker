import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KEYS_KEY, KEYS_REFRESH_KEY, KeyFollower, KeyManager, readKeys, type KV } from '../src/shared/keys.js';
import { retry } from '../src/shared/util.js';

function fakeKv() {
  const m = new Map<string, string>();
  const kv: KV = { get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, v), del: async (k) => void m.delete(k) };
  return { m, kv };
}
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const noSleep = async () => undefined;

function loginCounter(prefix = 'k') {
  const state = { calls: 0, fail: 0 };
  const login = async () => {
    state.calls++;
    if (state.fail > 0) {
      state.fail--;
      throw new Error('Temporary application error, request failed.');
    }
    return [`${prefix}${state.calls}-a`, `${prefix}${state.calls}-b`];
  };
  return { state, login };
}

test('manager publishes the key set, and versions keep increasing across restarts', async () => {
  const { kv } = fakeKv();
  const a = loginCounter('a');
  await new KeyManager(kv, a.login, { cooldownMs: 0 }).init();
  assert.deepEqual((await readKeys(kv))?.version, 1);
  const b = loginCounter('b');
  await new KeyManager(kv, b.login, { cooldownMs: 0 }).init(); // process restarted
  const s = await readKeys(kv);
  assert.equal(s?.version, 2);
  assert.deepEqual(s?.keys, ['b1-a', 'b1-b']);
});

test('relogin is single flight and waits out the cooldown between logins', async () => {
  const { kv } = fakeKv();
  const { state, login } = loginCounter();
  const waits: number[] = [];
  let t = 1_000;
  const mgr = new KeyManager(kv, login, { cooldownMs: 20_000, clock: () => t, sleep: async (ms) => void waits.push(ms) });
  await mgr.init(); // login 1 at t=1000
  t += 5_000;
  await Promise.all([mgr.relogin('x'), mgr.relogin('y'), mgr.relogin('z')]);
  assert.equal(state.calls, 2, 'three concurrent requests, one login');
  assert.deepEqual(waits, [15_000], 'waited for the remainder of the 20 s cooldown');
  assert.equal(mgr.currentVersion, 2);
});

test('a failed login publishes nothing and changes no version', async () => {
  const { kv } = fakeKv();
  const { state, login } = loginCounter();
  const mgr = new KeyManager(kv, login, { cooldownMs: 0 });
  await mgr.init();
  state.fail = 1;
  await assert.rejects(mgr.relogin('x'), /Temporary application error/);
  assert.equal((await readKeys(kv))?.version, 1);
  await mgr.relogin('again');
  assert.equal((await readKeys(kv))?.version, 2);
});

test('pollRefresh: ignores stale requests, serves current ones, clears the request', async () => {
  const { kv, m } = fakeKv();
  const { state, login } = loginCounter();
  const mgr = new KeyManager(kv, login, { cooldownMs: 0 });
  await mgr.init();
  assert.equal(await mgr.pollRefresh(), false, 'no request');
  await kv.set(KEYS_REFRESH_KEY, JSON.stringify({ seenVersion: 0, at: 1 }));
  assert.equal(await mgr.pollRefresh(), false, 'requester was behind: newer keys already published');
  assert.equal(m.has(KEYS_REFRESH_KEY), false);
  assert.equal(state.calls, 1);
  await kv.set(KEYS_REFRESH_KEY, JSON.stringify({ seenVersion: 1, at: 2 }));
  assert.equal(await mgr.pollRefresh(), true);
  assert.equal(state.calls, 2);
  assert.equal(m.has(KEYS_REFRESH_KEY), false);
});

test('follower waits for the first key set and applies it', async () => {
  const { kv } = fakeKv();
  const applied: string[][] = [];
  const f = new KeyFollower(kv, (k) => applied.push(k), { pollMs: 5 });
  const mgr = new KeyManager(kv, loginCounter().login, { cooldownMs: 0 });
  setTimeout(() => void mgr.init(), 30);
  await f.waitForInitial(undefined, 2_000);
  assert.deepEqual(applied, [['k1-a', 'k1-b']]);
  assert.equal(f.version, 1);
});

test('follower fails with a clear message when no manager ever publishes', async () => {
  const f = new KeyFollower(fakeKv().kv, () => undefined, { pollMs: 5 });
  await assert.rejects(f.waitForInitial(undefined, 40), /Start `npm run availability` first/);
});

test('a rejected key triggers a refresh request, the manager logs in once, and the follower swaps keys', async () => {
  const { kv } = fakeKv();
  const { state, login } = loginCounter();
  const mgr = new KeyManager(kv, login, { cooldownMs: 0 });
  await mgr.init();
  const applied: string[][] = [];
  const f = new KeyFollower(kv, (k) => applied.push(k), { pollMs: 5, cooldownMs: 0 });
  await f.adoptIfNewer();
  const serving = setInterval(() => void mgr.pollRefresh(), 10);
  await f.recover();
  clearInterval(serving);
  assert.equal(state.calls, 2);
  assert.deepEqual(applied.at(-1), ['k2-a', 'k2-b']);
  assert.equal(f.version, 2);
});

test('four processes hitting 403 at once cause exactly one login', async () => {
  const { kv } = fakeKv();
  const { state, login } = loginCounter();
  const mgr = new KeyManager(kv, login, { cooldownMs: 0 });
  await mgr.init();
  const followers = Array.from({ length: 4 }, () => new KeyFollower(kv, () => undefined, { pollMs: 5, cooldownMs: 0 }));
  await Promise.all(followers.map((f) => f.adoptIfNewer()));
  const serving = setInterval(() => void mgr.pollRefresh().catch(() => undefined), 8);
  await Promise.all(followers.flatMap((f) => [f.recover(), f.recover()]));
  clearInterval(serving);
  assert.equal(state.calls, 2, 'one startup login plus one for all four processes');
  assert.deepEqual(followers.map((f) => f.version), [2, 2, 2, 2]);
});

test('a recover right after a successful one returns at once (fresh keys, stragglers just retry)', async () => {
  const { kv, m } = fakeKv();
  const mgr = new KeyManager(kv, loginCounter().login, { cooldownMs: 0 });
  await mgr.init();
  const f = new KeyFollower(kv, () => undefined, { pollMs: 5, cooldownMs: 60_000 });
  await f.adoptIfNewer();
  const serving = setInterval(() => void mgr.pollRefresh(), 8);
  await f.recover();
  clearInterval(serving);
  m.delete(KEYS_REFRESH_KEY);
  await f.recover();
  assert.equal(m.has(KEYS_REFRESH_KEY), false, 'no new request was written');
});

test('recover gives up with a clear error when the manager is not running', async () => {
  const { kv } = fakeKv();
  await kv.set(KEYS_KEY, JSON.stringify({ version: 1, keys: ['x'], publishedAt: 1 }));
  const f = new KeyFollower(kv, () => undefined, { pollMs: 5, recoverTimeoutMs: 40 });
  await f.adoptIfNewer();
  await assert.rejects(f.recover(), /published no new keys/);
});

test('the watcher adopts a newer key set before any request has failed', async () => {
  const { kv } = fakeKv();
  const mgr = new KeyManager(kv, loginCounter().login, { cooldownMs: 0, sleep: noSleep });
  await mgr.init();
  const applied: string[][] = [];
  const f = new KeyFollower(kv, (k) => applied.push(k), { pollMs: 5 });
  await f.adoptIfNewer();
  await mgr.relogin('rotation');
  assert.equal(await f.adoptIfNewer(), true);
  assert.equal(applied.length, 2);
});

test('retry: succeeds after transient failures, gives up after the attempts, reports each retry', async () => {
  let n = 0;
  const seen: number[] = [];
  const v = await retry(async () => { if (++n < 3) throw new Error('Temporary application error'); return 'ok'; }, { attempts: 5, baseMs: 1, capMs: 2, onRetry: (_e, a) => void seen.push(a) });
  assert.deepEqual([v, n, seen], ['ok', 3, [1, 2]]);
  let m = 0;
  await assert.rejects(retry(async () => { m++; throw new Error('down'); }, { attempts: 3, baseMs: 1, capMs: 2 }), /down/);
  assert.equal(m, 3);
});
