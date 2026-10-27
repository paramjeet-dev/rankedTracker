import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pacer } from '../src/shared/pacer.js';

function fakeClock() {
  let t = 1_000_000;
  return { now: () => t, sleep: async (ms: number) => void (t += ms), advance: (ms: number) => void (t += ms) };
}

test('request starts are spaced evenly, not bursted', async () => {
  const clk = fakeClock();
  const p = new Pacer({ rps: 10, maxInFlight: 100, now: clk.now, sleep: clk.sleep });
  const starts: number[] = [];
  for (let i = 0; i < 5; i++) {
    const release = await p.acquire();
    starts.push(clk.now());
    release();
  }
  const gaps = starts.slice(1).map((s, i) => s - (starts[i] as number));
  assert.deepEqual(gaps, [100, 100, 100, 100]);
});

test('in-flight cap blocks until a request finishes', async () => {
  const clk = fakeClock();
  const p = new Pacer({ rps: 1000, maxInFlight: 2, now: clk.now, sleep: clk.sleep });
  const r1 = await p.acquire();
  await p.acquire();
  let third = false;
  const pending = p.acquire().then((r) => {
    third = true;
    return r;
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(third, false);
  assert.equal(p.active, 2);
  r1();
  (await pending)();
  assert.equal(third, true);
});

test('pressure halves the rate (floored) and success streaks recover it', () => {
  const p = new Pacer({ rps: 10, maxInFlight: 4, minRps: 2, recoverAfter: 3 });
  p.onPressure();
  assert.equal(p.currentRps, 5);
  p.onPressure();
  p.onPressure();
  assert.equal(p.currentRps, 2); // 10 -> 5 -> 2.5 -> floored at minRps
  for (let i = 0; i < 3; i++) p.onSuccess();
  assert.ok(p.currentRps > 2);
  assert.ok(p.currentRps <= 10);
});

test('release is idempotent', async () => {
  const p = new Pacer({ rps: 1000, maxInFlight: 1 });
  const r = await p.acquire();
  r();
  r();
  assert.equal(p.active, 0);
});
