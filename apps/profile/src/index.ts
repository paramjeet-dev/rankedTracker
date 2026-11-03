/** Profile worker: player -> current/previous league group refs -> discover groups (queues roster jobs). */
import { runWorker, cocGet, playerPath, parseProfile, saveProfile, discoverGroup, seasonEnded, envNum } from "@coc/core";
import { inScope } from "@coc/shared";
process.env.PROC_NAME ??= "profile";

await runWorker({ name: "profile", kinds: ["profile"], concurrency: envNum("CONC_PROFILE", 20), rps: envNum("RPS_PROFILE", 20), handlers: {
  async profile(job) {
    const tag: string = job.payload.tag;
    const p = parseProfile(await cocGet(playerPath(tag), { kind: "player", key: tag }));
    await saveProfile(p);
    // Only players currently in an in-scope tier expand the crawl (roster graph: members -> their current/previous groups -> their rosters ...).
    if (p.tierId === null || !inScope(p.tierId)) return;
    if (p.current) await discoverGroup(p.current.seasonId, p.current.groupTag, p.tag, p.tierId, seasonEnded(p.current.seasonId) ? 1 : 6);
    if (p.previous) await discoverGroup(p.previous.seasonId, p.previous.groupTag, p.tag, null, seasonEnded(p.previous.seasonId) ? 1 : 6);
  } } });
