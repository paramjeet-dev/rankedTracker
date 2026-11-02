/** Aggregator: rebuilds derived tables for recent seasons whenever new battles landed. Reads Postgres only (no API calls). */
import { sql, sleep, log, rebuildSeason, refitExpectedStars, scoreSeason } from "@coc/core";
process.env.PROC_NAME ??= "aggregator";

const seen = new Map<number, number>(); // season -> battle count at last build
for (;;) {
  try {
    const rows = await sql<{ season_id: number; n: number }[]>`select season_id, count(*)::int n from battle group by 1 order by 1 desc limit 4`;
    const dirty = rows.filter((r) => seen.get(Number(r.season_id)) !== r.n);
    if (dirty.length) {
      await refitExpectedStars();
      for (const r of dirty) { await rebuildSeason(Number(r.season_id)); await scoreSeason(Number(r.season_id)); seen.set(Number(r.season_id), r.n); log("aggregator", `rebuilt season ${r.season_id} (${r.n} battles)`); }
    }
  } catch (e) { log("aggregator", "error", e); }
  await sleep(15 * 60_000);
}
