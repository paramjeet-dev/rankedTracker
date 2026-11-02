/** Ranked-battle trophy rules (from the user's rule summary). Validate against live data. */

/** Trophies the ATTACKER earns for one attack. */
export function attackerTrophies(stars: number, destruction: number): number {
  if (stars >= 3) return 40;
  if (stars === 2) return Math.min(32, 16 + Math.floor((destruction - 50) / 3));
  if (stars === 1) return Math.min(15, 5 + Math.floor((destruction - 1) / 9));
  return Math.min(4, Math.floor(destruction / 10)); // 0 stars; <10% gives 0
}

/** Trophies the DEFENDER earns for the same battle. */
export function defenderTrophies(stars: number, destruction: number): number {
  if (stars >= 3) return 0;
  if (stars === 0) return 40;
  return 40 - attackerTrophies(stars, destruction);
}

/**
 * End-of-week compensation for defenses not taken: average defense gain * missing defenses.
 * Rounding and "entitled defenses" are UNVERIFIED: compare against the residual in reconciliation.
 */
export function expectedMissingDefenseBonus(defenseGains: number[], entitledDefenses: number): number {
  if (defenseGains.length === 0) return 0;
  const missing = Math.max(0, entitledDefenses - defenseGains.length);
  const avg = defenseGains.reduce((a, b) => a + b, 0) / defenseGains.length;
  return missing * avg;
}

export interface Reconciliation { computed: number; reported: number; residual: number; expectedBonus: number; ok: boolean }

/** Final trophies = sum(attack gains) + sum(defense gains) + bonus. Tolerance covers unknown bonus rounding. */
export function reconcile(
  attackGains: number[], defenseGains: number[], entitledDefenses: number, reportedFinal: number, tolerance = 2,
): Reconciliation {
  const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
  const computed = sum(attackGains) + sum(defenseGains);
  const expectedBonus = expectedMissingDefenseBonus(defenseGains, entitledDefenses);
  const residual = reportedFinal - computed;
  return { computed, reported: reportedFinal, residual, expectedBonus, ok: Math.abs(residual - expectedBonus) <= tolerance };
}
