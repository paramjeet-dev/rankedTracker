import type pg from 'pg';

export interface Scope {
  min: number;
  max: number;
  has(tierId: number | null | undefined): boolean;
}

/**
 * Tracked tiers come from `league_tier.in_scope` (set by `npm run seed-tiers`), the same source the old crawler
 * used, so there is one definition of scope. Queries use BETWEEN min AND max, so the set must be contiguous.
 */
export async function loadScope(pool: pg.Pool): Promise<Scope> {
  const res = await pool.query<{ tier_id: string }>('SELECT tier_id FROM league_tier WHERE in_scope ORDER BY tier_id');
  const ids = res.rows.map((r) => Number(r.tier_id));
  if (ids.length === 0) throw new Error('league_tier has no in_scope rows. Run: npm run seed-tiers');
  const min = ids[0] as number;
  const max = ids[ids.length - 1] as number;
  if (max - min + 1 !== ids.length) {
    throw new Error(`league_tier.in_scope is not a contiguous range (${ids.join(', ')}); the new processes assume min..max.`);
  }
  const set = new Set(ids);
  return { min, max, has: (id) => id != null && set.has(Number(id)) };
}
