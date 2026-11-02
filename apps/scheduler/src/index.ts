/** Scheduler: stale-job recovery, daily seeds, season-end sweeps (3 passes), raw pruning, coverage report. Makes no API calls. */
import { sql, sleep, log, enqueue, enqueueMany, requeueStale, pruneRaw, currentSeasonId } from "@coc/core";
import { SEASON_LEN } from "@coc/shared";
process.env.PROC_NAME ??= "scheduler";

const getState = async (k: string) => (await sql`select value from system_state where key = ${k}`)[0]?.value;
const setState = (k: string, v: unknown) => sql`insert into system_state (key, value, updated_at) values (${k}, ${sql.json(v as any)}, now()) on conflict (key) do update set value = excluded.value, updated_at = now()`;

/** Sweep passes for the season that just ended: +0h, +24h, +72h. A roster refresh re-queues every missing member log (deduped). */
async function sweep() {
  const ended = currentSeasonId() - SEASON_LEN;
  const passAt = [0, 24 * 3600, 72 * 3600]; // seconds after season end
  const st = (await getState("sweep")) ?? { seasonId: 0, pass: 0 };
  if (st.seasonId !== ended) { st.seasonId = ended; st.pass = 0; }
  const elapsed = Date.now() / 1000 - (ended + SEASON_LEN);
  while (st.pass < passAt.length && elapsed >= passAt[st.pass]) {
    const groups = await sql<{ group_tag: string; probe_player_tag: string }[]>`select group_tag, probe_player_tag from league_group where season_id = ${ended}`;
    await sql`update league_group set roster_fetched_at = null where season_id = ${ended}`; // force a fresh post-season roster
    await enqueueMany(groups.map((g) => ({ kind: "roster", dedupeKey: `${ended}:${g.group_tag}`, payload: { seasonId: ended, groupTag: g.group_tag, probeTag: g.probe_player_tag }, priority: 1 })));
    log("scheduler", `sweep pass ${st.pass} for season ${ended}: ${groups.length} groups`);
    st.pass++;
  }
  await setState("sweep", st);
}

let lastDaily = "", lastCoverage = 0;
for (;;) {
  try {
    await requeueStale(10);
    await sweep();
    const day = new Date().toISOString().slice(0, 10);
    if (day !== lastDaily) {
      lastDaily = day;
      await enqueue({ kind: "seed_locations", dedupeKey: day, payload: {}, priority: 6 });
      // backfill group tier from members' history rows (majority vote)
      await sql`update league_group g set tier_id = x.tier from (
        select gm.season_id, gm.group_tag, mode() within group (order by ps.tier_id) as tier
        from group_member gm join player_season ps on ps.player_tag = gm.player_tag and ps.season_id = gm.season_id
        group by 1, 2) x where g.season_id = x.season_id and g.group_tag = x.group_tag and g.tier_id is null`;
      log("scheduler", `pruned ${pruneRaw()} raw day-directories`);
    }
    if (Date.now() - lastCoverage > 600_000) {
      lastCoverage = Date.now();
      const rows = await sql`select * from coverage_by_season order by season_id desc limit 3`;
      const q = await sql`select kind, status, count(*)::int as n from job group by 1, 2 order by 1, 2`;
      log("scheduler", "coverage", JSON.stringify(rows), "queue", JSON.stringify(q));
    }
  } catch (e) { log("scheduler", "error", e); }
  await sleep(60_000);
}
