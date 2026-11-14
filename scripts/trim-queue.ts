/** Free the job queue. Dry run by default: prints what each rule would delete.
 *   npm run trim-queue                                  dry run
 *   npm run trim-queue -- --keep-weeks 2 --apply        delete roster/memberlog jobs of seasons older than (current - 2 weeks); jobs the API can no longer serve are always included
 *   --drop-failed        also delete failed/parked jobs
 *   --trim-profiles      keep only PROFILES_PER_GROUP (8) queued roster-discovered profile jobs per group
 *   --trim-history       delete queued history jobs of players with no group_member row in a kept season (they can be re-queued later from player.last_history_at is null)
 *  Running workers are unaffected: only queued rows are touched. Ends with VACUUM ANALYZE job when --apply. */
import { sql, trimProfileQueue, envNum } from "@coc/core";
import { SEASON_LEN, SEASON_WINDOW_WEEKS, currentSeasonId } from "@coc/shared";

const has = (f: string) => process.argv.includes(f), i = process.argv.indexOf("--keep-weeks");
const apply = has("--apply"), keepWeeks = i >= 0 ? Number(process.argv[i + 1]) : 2;
const cur = currentSeasonId(), apiFloor = cur - SEASON_WINDOW_WEEKS * SEASON_LEN, keepFloor = cur - keepWeeks * SEASON_LEN;
const day = (s: number) => new Date(s * 1000).toISOString().slice(0, 10);
const seasonJobs = sql`status = 'queued' and kind in ('roster', 'memberlog') and payload ? 'seasonId'`;
const rules: { name: string; where: ReturnType<typeof sql> }[] = [
  { name: `A. roster/memberlog queued for seasons < ${day(apiFloor)} (API no longer serves them)`, where: sql`${seasonJobs} and (payload->>'seasonId')::bigint < ${apiFloor}` },
  ...(keepFloor > apiFloor ? [{ name: `B. roster/memberlog queued for seasons ${day(apiFloor)} .. < ${day(keepFloor)} (outside the ${keepWeeks + 1} kept seasons)`, where: sql`${seasonJobs} and (payload->>'seasonId')::bigint >= ${apiFloor} and (payload->>'seasonId')::bigint < ${keepFloor}` }] : []),
  ...(has("--drop-failed") ? [{ name: "C. failed / parked jobs", where: sql`status = 'failed'` }] : []),
  ...(has("--trim-history") ? [{ name: `E. queued history jobs of players with no group_member row in seasons >= ${day(keepFloor)}`,
    where: sql`status = 'queued' and kind = 'history' and not exists (select 1 from group_member gm where gm.player_tag = job.payload->>'tag' and gm.season_id >= ${keepFloor})` }] : []),
];

console.log(`Current season ${day(cur)} | API floor ${day(apiFloor)} | keeping ${keepWeeks + 1} seasons from ${day(keepFloor)}\n`);
console.table(await sql`select kind, status, count(*)::int n from job group by 1, 2 order by 1, 2`);
for (const r of rules) {
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int n from job where ${r.where}`;
  console.log(`${r.name}: ${n}`);
  if (apply && n) { let done = 0; for (;;) { const d = await sql`delete from job where id in (select id from job where ${r.where} limit 100000)`; done += d.count; if (!d.count) break; console.log(`  deleted ${done}`); } }
}
if (has("--trim-profiles")) console.log("D. profile backlog:", JSON.stringify(await trimProfileQueue(envNum("PROFILES_PER_GROUP", 8), apply)));
if (apply) { await sql.unsafe("vacuum (analyze) job"); console.log("\nvacuum analyze done"); } else console.log("\n(dry run; nothing deleted; add --apply)");
await sql.end();
