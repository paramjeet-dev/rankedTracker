import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AvailabilityState } from '../src/shared/availability-state.js';
import { AvailabilityController } from '../src/shared/controller.js';

function rig() {
  let t = 1_000;
  let probeError: unknown = null;
  const published: AvailabilityState[] = [];
  const events: Array<[string, Record<string, unknown>]> = [];
  const c = new AvailabilityController({
    clock: () => t,
    probe: async () => void (probeError && (() => { throw probeError; })()),
    publish: async (s) => void published.push(s),
    emit: async (type, f) => void events.push([type, f])
  });
  return { c, published, events, fail: (e: unknown) => void (probeError = e), heal: () => void (probeError = null), tick: (ms: number) => void (t += ms) };
}

test('outage start is preserved across failed probes and recovery reports the full duration', async () => {
  const r = rig();
  await r.c.tick();
  r.tick(15_000);
  r.fail(Object.assign(new Error('maintenance'), { status: 503, reason: 'inMaintenance' }));
  const down = await r.c.tick();
  assert.equal(down.available, false);
  assert.equal(down.maintenance, true);
  const since = down.since;
  r.tick(15_000);
  const still = await r.c.tick();
  assert.equal(still.since, since);
  r.tick(15_000);
  r.heal();
  const up = await r.c.tick();
  assert.equal(up.available, true);
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0]?.[0], 'availability.recovered');
  assert.equal(r.events[0]?.[1]['durationMs'], 30_000);
  assert.equal(r.events[0]?.[1]['maintenance'], true);
});

test('an HTML gateway error is a proxy outage, not maintenance', async () => {
  const r = rig();
  r.fail(new SyntaxError(`Unexpected token '<', "<html>"`));
  const s = await r.c.tick();
  assert.equal(s.available, false);
  assert.equal(s.maintenance, false);
});

test('a throttled probe means reachable: gate stays open', async () => {
  const r = rig();
  r.fail(Object.assign(new Error('x'), { status: 429, reason: 'requestThrottled' }));
  assert.equal((await r.c.tick()).available, true);
});

test('every tick publishes a fresh heartbeat', async () => {
  const r = rig();
  await r.c.tick();
  r.tick(15_000);
  await r.c.tick();
  assert.deepEqual(r.published.map((s) => s.heartbeat), [1_000, 16_000]);
});
