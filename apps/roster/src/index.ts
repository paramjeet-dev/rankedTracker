/** Roster worker: layer B. The probe's own logs come back in the same response, so the probe's battles are stored too. */
import { runWorker, cocGet, groupPath, parseGroup, saveGroup, queueMemberLogs, tierOfPlayerSeason, sql, envNum } from "@coc/core";
import { inScope } from "@coc/shared";
process.env.PROC_NAME ??= "roster";

await runWorker({ name: "roster", kinds: ["roster"], concurrency: envNum("CONC_ROSTER", 60), rps: envNum("RPS_ROSTER", 30), handlers: {
  async roster(job) {
    const { seasonId, groupTag, probeTag } = job.payload;
    const [row] = await sql<{ tier_id: number | null }[]>`select tier_id from league_group where season_id = ${seasonId} and group_tag = ${groupTag}`;
    let tier = row?.tier_id != null ? Number(row.tier_id) : null;
    if (tier === null) { // legacy rows from before tier checks: resolve from the probe's history
      tier = await tierOfPlayerSeason(probeTag, seasonId);
      if (tier !== null) await sql`update league_group set tier_id = ${tier} where season_id = ${seasonId} and group_tag = ${groupTag}`;
    }
    if (tier === null || !inScope(tier)) return; // not a tracked group: no roster call, no follow-up work
    const g = parseGroup(await cocGet(groupPath(groupTag, seasonId, probeTag), { kind: "group", key: `${groupTag}:${probeTag}`, seasonId }), probeTag);
    await saveGroup(g, seasonId, groupTag, probeTag);
    await queueMemberLogs(seasonId, groupTag); // no-op until the season has ended
  } } });
