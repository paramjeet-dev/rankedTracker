/** One-time, after migration 005: copy payload.seasonId into job.season_id for queued roster/memberlog rows (id windows, so each step is an index range scan). */
import { sql } from "@coc/core";
const [{ max }] = await sql<{ max: string | null }[]>`select max(id)::text as max from job`;
const top = Number(max ?? 0), step = 200_000; let done = 0;
for (let a = 0; a <= top; a += step) {
  const r = await sql`update job set season_id = (payload->>'seasonId')::bigint where id >= ${a} and id < ${a + step} and season_id is null and payload ? 'seasonId'`;
  done += r.count; console.log(`ids ${a}..${a + step}: ${r.count} rows (total ${done})`);
}
await sql`analyze job`; console.log("done");
await sql.end();
