import { sql } from "./db.js";

export interface Job { id: number; kind: string; dedupeKey: string; payload: any; attempts: number }
export interface NewJob { kind: string; dedupeKey: string; payload: unknown; priority?: number; delaySec?: number }

/** Lower priority number = sooner. Duplicate queued/running jobs (same kind + dedupeKey) are ignored. */
export async function enqueueMany(jobs: NewJob[]): Promise<void> {
  if (jobs.length === 0) return;
  const rows = jobs.map((j) => ({ kind: j.kind, dedupe_key: j.dedupeKey, payload: j.payload, priority: j.priority ?? 5, delay: j.delaySec ?? 0 }));
  for (let i = 0; i < rows.length; i += 5000) {
    await sql`
      insert into job (kind, dedupe_key, payload, priority, run_after)
      select t.kind, t.dedupe_key, t.payload, t.priority, now() + make_interval(secs => t.delay)
      from jsonb_to_recordset(${sql.json(rows.slice(i, i + 5000) as any)}::jsonb)
        as t(kind text, dedupe_key text, payload jsonb, priority smallint, delay int)
      order by t.kind, t.dedupe_key
      on conflict (kind, dedupe_key) where status in ('queued','running') do nothing`;
  }
}
export const enqueue = (j: NewJob) => enqueueMany([j]);

export async function claim(kinds: string[], limit: number): Promise<Job[]> {
  return sql<Job[]>`
    update job set status = 'running', locked_at = now(), attempts = attempts + 1, updated_at = now()
    where id in (
      select id from job
      where status = 'queued' and kind in ${sql(kinds)} and run_after <= now()
      order by priority, run_after, id limit ${limit} for update skip locked)
    returning id, kind, dedupe_key as "dedupeKey", payload, attempts`;
}

export const complete = (id: number) => sql`delete from job where id = ${id}`;

/** Park jobs without running them (reversible: update job set status='queued' where last_error like 'season outside API window%'). */
export const parkJobs = (ids: number[], why: string) =>
  ids.length ? sql`update job set status = 'failed', last_error = ${why}, updated_at = now() where id in ${sql(ids)}` : Promise.resolve();

/** countAttempt=false for "try later" signals (429, maintenance) that must not exhaust attempts. */
export async function retryLater(job: Job, delayMs: number, err: string, countAttempt: boolean, maxAttempts: number) {
  if (countAttempt && job.attempts >= maxAttempts) {
    await sql`update job set status = 'failed', last_error = ${err}, updated_at = now() where id = ${job.id}`;
    return;
  }
  await sql`update job set status = 'queued', attempts = attempts - ${countAttempt ? 0 : 1}, last_error = ${err},
            run_after = now() + make_interval(secs => ${delayMs / 1000}), updated_at = now() where id = ${job.id}`;
}

export const requeueStale = (minutes = 10) =>
  sql`update job set status = 'queued', updated_at = now() where status = 'running' and locked_at < now() - make_interval(mins => ${minutes})`;
