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
console.log("Request rate (successful responses) and failed attempts");
console.table(await sql`select round(count(*) filter (where status > 0 and at > now() - interval '1 min') / 60.0, 1) req_per_s_1min,
  round(count(*) filter (where status > 0) / 600.0, 1) req_per_s_10min, count(*) filter (where status = 0)::int failed_attempts_10min from fetch_log where at > now() - interval '10 min'`);
console.log("Latency by endpoint, last 10 min (queue = waited in gateway, ttfb = gateway -> official API; avg_ms - queue - ttfb ~ tunnel + download)");
console.table(await sql`select endpoint, count(*)::int n, round(avg(ms))::int avg_ms, round(percentile_cont(0.95) within group (order by ms))::int p95_ms,
  round(avg(queue_ms))::int queue_ms, round(avg(ttfb_ms))::int ttfb_ms from fetch_log where at > now() - interval '10 min' and status > 0 group by 1 order by 2 desc`);
console.log("Failed attempts by cause, last 10 min (TIMEOUT / ECONNRESET = tunnel trouble; ECONNREFUSED = gateway or tunnel down)");
console.table(await sql`select err, count(*)::int n from fetch_log where status = 0 and at > now() - interval '10 min' group by 1 order by 2 desc`);
console.log("Job errors (ParseError = payload shape differs; look at data/raw to fix the parser)");
console.table(await sql`select kind, left(last_error, 110) error, count(*)::int n from job where last_error is not null group by 1, 2 order by 3 desc limit 8`);
console.log("Data");
console.table(await sql`select (select count(*) from player)::int players, (select count(*) from player_season)::int season_rows,
  (select count(*) from league_group)::int groups, (select count(*) from league_group where roster_fetched_at is not null)::int rostered,
  (select count(*) from group_member)::int members, (select count(*) from group_member where log_final)::int final_logs, (select count(*) from battle)::int battles`);
console.log("Groups by tier (null = unresolved; only 105000026..105000033 are tracked)");
console.table(await sql`select coalesce(tier_id::text, 'unknown') tier, count(*)::int groups from league_group group by 1 order by 1`);
console.log("Largest tables");
console.table(await sql`select c.relname, pg_size_pretty(pg_total_relation_size(c.oid)) size, c.reltuples::bigint approx_rows from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r' order by pg_total_relation_size(c.oid) desc limit 6`);
console.log("Coverage by season"); console.table(await sql`select * from coverage_by_season order by season_id desc limit 3`);
const [db] = await sql`select pg_size_pretty(pg_database_size(current_database())) size`;
console.log(`Postgres size: ${db.size}   raw files: ${(dirSize(cfg.rawDir) / 1e6).toFixed(1)} MB`);
await sql.end();
