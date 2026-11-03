/** Profile worker: player -> current/previous league group refs -> discover in-scope groups (queues roster jobs). */
import { runWorker, cocGet, playerPath, parseProfile, saveProfile, discoverGroup, seasonEnded, tierOfPlayerSeason, envNum } from "@coc/core";
import { inScope } from "@coc/shared";
process.env.PROC_NAME ??= "profile";

await runWorker({ name: "profile", kinds: ["profile"], concurrency: envNum("CONC_PROFILE", 45), rps: envNum("RPS_PROFILE", 15), handlers: {
  async profile(job) {
    const tag: string = job.payload.tag;
    const p = parseProfile(await cocGet(playerPath(tag), { kind: "player", key: tag }));
    await saveProfile(p);
    // Only players currently in a tracked tier expand the crawl (roster graph: members -> their groups -> rosters ...).
    if (p.tierId === null || !inScope(p.tierId)) return;
    if (p.current) await discoverGroup(p.current.seasonId, p.current.groupTag, p.tag, p.tierId, seasonEnded(p.current.seasonId) ? 1 : 6);
    if (p.previous) {
      // the previous group may belong to a different tier (promoted/demoted since): ask the player's history for that season's tier first
      const tier = await tierOfPlayerSeason(p.tag, p.previous.seasonId);
      await discoverGroup(p.previous.seasonId, p.previous.groupTag, p.tag, tier, seasonEnded(p.previous.seasonId) ? 1 : 6);
    }
  } } });
