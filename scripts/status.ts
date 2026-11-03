/** One-shot health report: npm run status */
import fs from "node:fs";
import path from "node:path";
import { sql, cfg } from "@coc/core";

const dirSize = (d: string): number => !fs.existsSync(d) ? 0 : fs.readdirSync(d, { withFileTypes: true }).reduce((n, f) => n + (f.isDirectory() ? dirSize(path.join(d, f.name)) : fs.statSync(path.join(d, f.name)).size), 0);

console.log("\nAvailability (age_s should stay under ~20 while the availability process runs)");
console.table(await sql`select value->>'available' available, value->>'maintenance' maintenance, extract(epoch from now() - updated_at)::int age_s from system_state where key = 'clash_availability'`);
console.log("Queue"); console.table(await sql`select kind, status, count(*)::int n from job group by 1, 2 order by 1, 2`);
console.log("API calls, last 10 min, by HTTP status (200 should dominate; 403/429/5xx are problems)");
console.table(await sql`select status, count(*)::int n, round(avg(ms))::int avg_ms from fetch_log where at > now() - interval '10 min' group by 1 order by 2 desc`);
console.log("Current request rate"); console.table(await sql`select round(count(*) / 60.0, 1) as req_per_s_last_minute from fetch_log where at > now() - interval '1 min'`);
console.log("Job errors (ParseError = payload shape differs; look at data/raw to fix the parser)");
console.table(await sql`select kind, left(last_error, 110) error, count(*)::int n from job where last_error is not null group by 1, 2 order by 3 desc limit 8`);
console.log("Data");
console.table(await sql`select (select count(*) from player)::int players, (select count(*) from player_season)::int season_rows,
  (select count(*) from league_group)::int groups, (select count(*) from league_group where roster_fetched_at is not null)::int rostered,
  (select count(*) from group_member)::int members, (select count(*) from group_member where log_final)::int final_logs, (select count(*) from battle)::int battles`);
console.log("Coverage by season"); console.table(await sql`select * from coverage_by_season order by season_id desc limit 3`);
const [db] = await sql`select pg_size_pretty(pg_database_size(current_database())) size`;
console.log(`Postgres size: ${db.size}   raw files: ${(dirSize(cfg.rawDir) / 1e6).toFixed(1)} MB`);
await sql.end();
