/** Roster worker: layer B. The probe's own logs come back in the same response, so the probe's battles are stored too. */
import { runWorker, cocGet, groupPath, parseGroup, saveGroup, queueMemberLogs, envNum } from "@coc/core";
process.env.PROC_NAME ??= "roster";

await runWorker({ name: "roster", kinds: ["roster"], concurrency: envNum("CONC_ROSTER", 30), rps: envNum("RPS_ROSTER", 30), handlers: {
  async roster(job) {
    const { seasonId, groupTag, probeTag } = job.payload;
    const g = parseGroup(await cocGet(groupPath(groupTag, seasonId, probeTag), { kind: "group", key: `${groupTag}:${probeTag}`, seasonId }), probeTag);
    await saveGroup(g, seasonId, groupTag, probeTag);
    await queueMemberLogs(seasonId, groupTag); // no-op until the season has ended
  } } });
