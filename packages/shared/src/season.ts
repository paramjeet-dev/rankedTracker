/** Season id appears to be the Unix start time (seconds) of the week, Monday 05:00 UTC. VERIFY on live data. */
export const SEASON_LEN = 7 * 24 * 3600;
export const SEASON_ANCHOR = 1791781200; // 2026-10-12T05:00:00Z, taken from a sample payload

export function seasonIdAt(unixSec: number): number {
  return SEASON_ANCHOR + Math.floor((unixSec - SEASON_ANCHOR) / SEASON_LEN) * SEASON_LEN;
}
export const currentSeasonId = (now = Date.now()) => seasonIdAt(Math.floor(now / 1000));
export const previousSeasonId = (now = Date.now()) => currentSeasonId(now) - SEASON_LEN;
export const seasonStart = (id: number) => new Date(id * 1000);
export const seasonEnd = (id: number) => new Date((id + SEASON_LEN) * 1000);

export const TIER_MIN = 105000026;
export const TIER_MAX = 105000033;
export const inScope = (tierId: number) => tierId >= TIER_MIN && tierId <= TIER_MAX;
