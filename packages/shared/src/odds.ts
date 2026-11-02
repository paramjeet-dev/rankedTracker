/**
 * Live promotion / demotion odds for one player mid-season, by Monte Carlo over the remaining battles.
 * Model (deliberately simple, replace once there is data): each remaining battle adds an independent gain ~ N(gainMean, gainSd), floored at 0
 * (trophies never decrease); ties are broken by a coin flip (the real tiebreak, average attack stars, is not modelled).
 * Fit gainMean/gainSd per tier from stored battles (mean of attacker_gain / defender_gain).
 */
export interface OddsPlayer { tag: string; trophies: number; remainingBattles: number }
export interface OddsResult { pPromote: number; pDemote: number; expectedRank: number }

export function simulateOdds(players: OddsPlayer[], target: string, promoteRate: number, demoteRate: number, gainMean: number, gainSd: number, runs = 4000, rand: () => number = Math.random): OddsResult {
  const n = players.length, promoteN = Math.ceil(promoteRate * n), demoteN = Math.ceil(demoteRate * n);
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
  let promo = 0, demo = 0, rankSum = 0;
  for (let r = 0; r < runs; r++) {
    const fin = players.map((p) => {
      let t = p.trophies;
      for (let i = 0; i < p.remainingBattles; i++) t += Math.max(0, gainMean + gainSd * gauss());
      return { tag: p.tag, t: t + rand() * 1e-6 }; // tiny jitter = coin-flip ties
    }).sort((a, b) => b.t - a.t);
    const rank = fin.findIndex((f) => f.tag === target) + 1;
    rankSum += rank;
    if (rank <= promoteN) promo++;
    if (rank > n - demoteN) demo++;
  }
  return { pPromote: promo / runs, pDemote: demo / runs, expectedRank: rankSum / runs };
}
