import { db } from './db.js';

export type JobKind = 'profile' | 'clan_members' | 'history_backfill' | 'group_fetch';

export interface Job {
  id: number;
  kind: JobKind;
  payload: any;
  attempts: number;
}

export const MAX_ATTEMPTS = Number(process.env.JOB_MAX_ATTEMPTS ?? 5);

/**
 * Enqueue jobs in bulk. (kind, payload) is unique.
 *  - existing queued/running job: only its priority is raised
 *  - existing done/failed job: left alone unless requeue=true (sweeps, explicit seeds)
 */
export async function enqueueMany(kind: JobKind, payloads: object[], priority = 100, requeue = false) {
  if (!payloads.length) return;
  await db.query(
    `INSERT INTO job (kind, payload, priority)
     SELECT $1, p, $3 FROM jsonb_array_elements($2::jsonb) p
     ON CONFLICT (kind, payload) DO UPDATE SET
       priority   = LEAST(job.priority, EXCLUDED.priority),
       status     = CASE WHEN $4 AND job.status IN ('done','failed') THEN 'queued' ELSE job.status END,
       attempts   = CASE WHEN $4 AND job.status IN ('done','failed') THEN 0 ELSE job.attempts END,
       run_after  = CASE WHEN $4 AND job.status IN ('done','failed') THEN now() ELSE job.run_after END,
       updated_at = now()`,
    [kind, JSON.stringify(payloads), priority, requeue]
  );
}

export const enqueue = (kind: JobKind, payload: object, priority = 100, requeue = false) =>
  enqueueMany(kind, [payload], priority, requeue);

export async function claim(): Promise<Job | null> {
  const { rows } = await db.query(
    `UPDATE job SET status = 'running', locked_at = now(), attempts = attempts + 1, updated_at = now()
     WHERE id = (
       SELECT id FROM job
       WHERE status = 'queued' AND run_after <= now()
       ORDER BY priority, run_after, id
       LIMIT 1
       FOR UPDATE SKIP LOCKED)
     RETURNING id, kind, payload, attempts`
  );
  return rows[0] ?? null;
}

export async function complete(id: number) {
  await db.query(`UPDATE job SET status = 'done', last_error = NULL, updated_at = now() WHERE id = $1`, [id]);
}

/** Returns true if the job will be retried, false if it is now permanently failed. */
export async function fail(job: Job, err: string, retryable: boolean): Promise<boolean> {
  if (retryable && job.attempts < MAX_ATTEMPTS) {
    const delaySec = Math.min(3600, 30 * 2 ** (job.attempts - 1));
    await db.query(
      `UPDATE job SET status = 'queued', last_error = $2, run_after = now() + ($3 || ' seconds')::interval, updated_at = now()
       WHERE id = $1`,
      [job.id, err.slice(0, 500), String(delaySec)]
    );
    return true;
  }
  await db.query(`UPDATE job SET status = 'failed', last_error = $2, updated_at = now() WHERE id = $1`, [job.id, err.slice(0, 500)]);
  return false;
}

/** Jobs left 'running' by a crashed or stopped process go back to the queue. */
export async function recoverStale(): Promise<number> {
  const r = await db.query(
    `UPDATE job SET status = 'queued', updated_at = now() WHERE status = 'running'`
  );
  return r.rowCount ?? 0;
}

export function isRetryable(e: any): boolean {
  const s = Number(e?.status ?? 0);
  if (s === 400 || s === 404) return false; // bad tag, or group/profile gone (retention)
  return true; // 403 (key rotation), 429, 5xx, network
}
