import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Client } from 'clashofclans.js';
import { AVAILABILITY_KEY, type AvailabilityState } from '../src/shared/availability-state.js';
import { ClashGateway } from '../src/shared/clash.js';
import { AvailabilityGate } from '../src/shared/gate.js';
import { Metrics } from '../src/shared/metrics.js';
import { Pacer } from '../src/shared/pacer.js';

const html = () => new SyntaxError(`Unexpected token '<', "<html>\n<h"... is not valid JSON`);
const http = (status: number, reason: string) => Object.assign(new Error(reason), { status, reason });

function build() {
  let state: AvailabilityState | null = null;
  const kv = { get: async () => (state ? JSON.stringify(state) : null) };
  const gate = new AvailabilityGate(kv, { pollMs: 10, halfOpenMs: 60_000 });
  const metrics = new Metrics();
  const pacers = { test: new Pacer({ rps: 1000, maxInFlight: 8 }) };
  const gateway = new ClashGateway({ client: {} as Client, gate, metrics, pacers });
  gate.start();
  // a tiny fake controller: healthy heartbeat every 20ms
  const hb = setInterval(() => void (state = { available: true, maintenance: false, since: 0, heartbeat: Date.now() }), 20);
  return { gateway, gate, metrics, stop: () => (clearInterval(hb), gate.stop()) };
}

test('HTML error closes the gate, then the same request succeeds after a healthy heartbeat', async () => {
  const t = build();
  let calls = 0;
  const res = await t.gateway.call('test', async () => {
    if (++calls === 1) throw html();
    return 'payload';
  });
  assert.equal(res.ok, true);
  assert.equal(calls, 2);
  t.stop();
});

test('a closed gate stops other workers from starting requests', async () => {
  const t = build();
  t.gate.close('unavailable');
  let started = 0;
  const p = t.gateway.call('test', async () => (started++, 'ok'));
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(started, 0, 'must not start while closed');
  assert.equal((await p).ok, true); // reopens on the next newer heartbeat
  assert.equal(started, 1);
  t.stop();
});

test('404 is permanent and not retried', async () => {
  const t = build();
  let calls = 0;
  const res = await t.gateway.call('test', async () => {
    calls++;
    throw http(404, 'notFound');
  });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.permanent, true);
  assert.equal(calls, 1);
  t.stop();
});

test('persistent 500s return a transient failure after bounded attempts (entity left for the next scan)', async () => {
  const t = build();
  let calls = 0;
  const res = await t.gateway.call(
    'test',
    async () => {
      calls++;
      throw http(500, 'unknownException');
    },
    { maxAttempts: 2 }
  );
  assert.equal(calls, 2);
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.permanent, false);
    assert.equal(res.kind, 'server');
  }
  t.stop();
});

test('a request that always returns HTML gives up after maxGateRetries instead of looping forever', async () => {
  const t = build();
  let calls = 0;
  const res = await t.gateway.call(
    'test',
    async () => {
      calls++;
      throw html();
    },
    { maxGateRetries: 2 }
  );
  assert.equal(res.ok, false);
  assert.equal(calls, 3);
  t.stop();
});

test('metrics break failures down by kind:status:reason', async () => {
  const t = build();
  await t.gateway.call('test', async () => { throw http(404, 'notFound'); });
  const s = t.metrics.drain('test', 1);
  assert.deepEqual(s.topErrors, [['not_found:404:notFound', 1]]);
  t.stop();
});

test('a 403 makes the gateway get new keys, reopen its own gate, and retry the same request successfully', async () => {
  const neverHealthy = { get: async () => null };
  const gate = new AvailabilityGate(neverHealthy, { pollMs: 10, authHoldMs: 60_000 });
  gate.start();
  let refreshed = 0;
  const gateway = new ClashGateway({
    client: {} as Client, gate, metrics: new Metrics(), pacers: { test: new Pacer({ rps: 1000, maxInFlight: 4 }) },
    relogin: async () => void refreshed++
  });
  let calls = 0;
  const res = await gateway.call('test', async () => {
    if (++calls === 1) throw Object.assign(new Error('Invalid authorization: API key does not allow access from IP 1.2.3.4'), { status: 403, reason: 'accessDenied.invalidIp' });
    return 'payload';
  });
  assert.equal(res.ok, true);
  assert.deepEqual([calls, refreshed], [2, 1]);
  gate.stop();
});

test('when new keys cannot be obtained the call ends with a bounded, non-permanent failure instead of looping', async () => {
  const gate = new AvailabilityGate({ get: async () => null }, { pollMs: 10, authHoldMs: 25 });
  gate.start();
  const keepAlive = setInterval(() => undefined, 50); // the gate's poll timer is unref'd; real processes have other handles
  try {
    let refreshes = 0;
    const gateway = new ClashGateway({
      client: {} as Client, gate, metrics: new Metrics(), pacers: { test: new Pacer({ rps: 1000, maxInFlight: 4 }) },
      relogin: async () => { refreshes++; throw new Error('key manager is down'); }
    });
    let calls = 0;
    const res = await gateway.call('test', async () => { calls++; throw Object.assign(new Error('x'), { status: 403, reason: 'accessDenied' }); }, { maxGateRetries: 2 });
    assert.equal(res.ok, false);
    if (!res.ok) assert.deepEqual([res.kind, res.permanent], ['auth', false]);
    assert.equal(calls, 3);
    assert.equal(refreshes, 3, 'every rejection asks for new keys, including the last one');
  } finally {
    clearInterval(keepAlive);
    gate.stop();
  }
});
