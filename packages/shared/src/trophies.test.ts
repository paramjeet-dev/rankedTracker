import { test } from "node:test";
import assert from "node:assert/strict";
import { attackerTrophies as a, defenderTrophies as d, reconcile } from "./trophies.js";
import { seasonIdAt, seasonStart } from "./season.js";

test("attacker trophies match the rule examples", () => {
  assert.equal(a(3, 100), 40);
  assert.equal(a(2, 50), 16);
  assert.equal(a(2, 98), 32);
  assert.equal(a(2, 73), 23);
  assert.equal(a(1, 1), 5);
  assert.equal(a(1, 91), 15);
  assert.equal(a(0, 9), 0);
  assert.equal(a(0, 10), 1);
  assert.equal(a(0, 49), 4);
});
test("defender trophies", () => {
  assert.equal(d(2, 73), 17);
  assert.equal(d(3, 100), 0);
  assert.equal(d(0, 45), 40);
});
test("reconcile flags a clean season", () => {
  const r = reconcile([40, 40], [10, 10], 4, 100); // 2 missing * avg 10 = 20 bonus; computed 100 -> residual 0 means NOT ok? check
  assert.equal(r.computed, 100);
  assert.equal(r.expectedBonus, 20);
  assert.equal(r.ok, false);
  assert.equal(reconcile([40, 40], [10, 10], 4, 120).ok, true);
});
test("season ids", () => {
  assert.equal(seasonIdAt(1791781200 + 3 * 86400), 1791781200);
  assert.equal(seasonStart(1791781200 + 3 * 604800).toISOString(), "2026-11-02T05:00:00.000Z");
});

import { simulateOdds } from "./odds.js";
test("promotion odds: clear leader promotes, clear laggard is demoted", () => {
  const ps = Array.from({ length: 20 }, (_, i) => ({ tag: `#P${i}`, trophies: 1000 - i * 40, remainingBattles: 2 }));
  const lead = simulateOdds(ps, "#P0", 0.3, 0.15, 20, 10, 800);
  const last = simulateOdds(ps, "#P19", 0.3, 0.15, 20, 10, 800);
  assert.ok(lead.pPromote > 0.99 && lead.pDemote < 0.01);
  assert.ok(last.pDemote > 0.9 && last.pPromote < 0.01);
});
