import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AVAILABILITY_KEY, type AvailabilityState } from '../src/shared/availability-state.js';
import { AvailabilityGate } from '../src/shared/gate.js';

function setup() {
  let t = 10_000;
  let state: AvailabilityState | null = null;
  const kv = { get: async (k: string) => (k === AVAILABILITY_KEY && state ? JSON.stringify(state) : null) };
  const gate = new AvailabilityGate(kv, { clock: () => t, controllerStaleMs: 45_000, halfOpenMs: 30_000 });
  return {
    gate,
    set: (s: Partial<AvailabilityState> | null) => void (state = s === null ? null : { available: true, maintenance: false, since: t, heartbeat: t, ...s }),
    tick: (ms: number) => void (t += ms),
    now: () => t
  };
}

test('closed gate ignores a heartbeat older than the closure and reopens on a newer healthy one', async () => {
  const s = setup();
  s.set({ heartbeat: s.now() });
  s.tick(1_000);
  s.gate.close('unavailable');
  await s.gate.refresh();
  assert.equal(s.gate.isOpen, false, 'stale-by-closure heartbeat must not reopen');
  s.tick(5_000);
  s.set({ heartbeat: s.now() });
  await s.gate.refresh();
  assert.equal(s.gate.isOpen, true);
});

test('controller reporting unavailable closes an open gate; stays closed until healthy', async () => {
  const s = setup();
  s.set({ available: false, maintenance: true, reason: 'maintenance', heartbeat: s.now() });
  await s.gate.refresh();
  assert.equal(s.gate.isOpen, false);
  assert.equal(s.gate.reason, 'maintenance');
  s.tick(15_000);
  s.set({ available: false, maintenance: true, heartbeat: s.now() });
  await s.gate.refresh();
  assert.equal(s.gate.isOpen, false);
  s.tick(15_000);
  s.set({ available: true, heartbeat: s.now() });
  await s.gate.refresh();
  assert.equal(s.gate.isOpen, true);
});

test('without a controller the gate half-opens after halfOpenMs instead of deadlocking', async () => {
  const s = setup();
  s.set(null);
  s.gate.close('unavailable');
  s.tick(10_000);
  await s.gate.refresh();
  assert.equal(s.gate.isOpen, false);
  s.tick(25_000);
  await s.gate.refresh();
  assert.equal(s.gate.isOpen, true);
});

test('waitOpen releases every waiter when the gate reopens', async () => {
  const s = setup();
  s.gate.close('unavailable');
  let released = 0;
  const waiters = [1, 2, 3].map(() => s.gate.waitOpen().then(() => void released++));
  await new Promise((r) => setImmediate(r));
  assert.equal(released, 0);
  s.tick(1_000);
  s.set({ heartbeat: s.now() });
  await s.gate.refresh();
  await Promise.all(waiters);
  assert.equal(released, 3);
});

test('waitOpen returns when aborted', async () => {
  const s = setup();
  s.gate.close('unavailable');
  const ac = new AbortController();
  const p = s.gate.waitOpen(ac.signal);
  ac.abort();
  await p;
});
