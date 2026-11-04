/** Member-log worker: layer C, the biggest consumer of API budget. Re-uses the same group response parser. */
import { runWorker, cocGet, groupPath, parseGroup, saveGroup, envNum } from "@coc/core";
process.env.PROC_NAME ??= "memberlog";

await runWorker({ name: "memberlog", kinds: ["memberlog"], concurrency: envNum("CONC_MEMBERLOG", 200), rps: envNum("RPS_MEMBERLOG", 100), prefetch: (j) => [{ path: groupPath(j.payload.groupTag, j.payload.seasonId, j.payload.playerTag), kind: "group", key: `${j.payload.groupTag}:${j.payload.playerTag}`, seasonId: j.payload.seasonId }], handlers: {
  async memberlog(job) {
    const { seasonId, groupTag, playerTag } = job.payload;
    const g = parseGroup(await cocGet(groupPath(groupTag, seasonId, playerTag), { kind: "group", key: `${groupTag}:${playerTag}`, seasonId }), playerTag);
    await saveGroup(g, seasonId, groupTag, playerTag, { roster: false });
  } } });
