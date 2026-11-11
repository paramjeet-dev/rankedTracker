import { sleep, log } from "./config.js";
import { claim, complete, retryLater, parkJobs, type Job } from "./queue.js";
import { oldestServedSeasonId } from "@coc/shared";
import { NotFound, RetryLater, setRps, limiterState, cocPrefetch, type PrefetchReq } from "./client.js";
import { isOpen, startGateWatcher } from "./gate.js";
import { ParseError } from "./parse.js";

export interface WorkerOpts { name: string; kinds: string[]; concurrency: number; rps: number; maxAttempts?: number; handlers: Record<string, (job: Job) => Promise<void>>;
  /** Calls this job will make, so a whole claimed batch is fetched in one gateway round trip (optional). */
  prefetch?: (job: Job) => PrefetchReq[] }

export async function runWorker(o: WorkerOpts) {
  const max = o.maxAttempts ?? 5;
  setRps(o.rps); startGateWatcher();
  let inflight = 0, stop = false, done = 0, failed = 0;
  for (const s of ["SIGINT", "SIGTERM"] as const) process.on(s, () => { stop = true; });
  setInterval(() => log(o.name, `claimed=${inflight} done=${done} failed=${failed} http-limit=${limiterState().limit} http-inflight=${limiterState().inflight}`), 30_000).unref();
  log(o.name, `started kinds=${o.kinds} concurrency=${o.concurrency} rps=${o.rps}`);

  const run = async (job: Job) => {
    try { await o.handlers[job.kind](job); await complete(job.id); done++; }
    catch (e: any) {
      if (e instanceof RetryLater) await retryLater(job, e.delayMs, e.message, false, max);
      else if (e?.code === "40P01" || e?.code === "40001") await retryLater(job, 500 + Math.random() * 2500, `db ${e.code} (deadlock/serialization), retrying`, false, max); // transient: don't burn attempts
      else if (e instanceof NotFound) { await complete(job.id); } // player/group gone: nothing to retry
      else if (e instanceof ParseError) { failed++; await retryLater(job, 0, `ParseError: ${e.message}`, true, 1); log(o.name, "PARSE ERROR", e.message); } // fail fast: raw is saved, fix parser, requeue
      else { failed++; await retryLater(job, Math.min(600_000, 5000 * 2 ** job.attempts), String(e?.message ?? e), true, max); }
    } finally { inflight--; }
  };

  while (!stop) {
    if (!isOpen()) { await sleep(1000); continue; }
    const free = o.concurrency - inflight;
    if (free <= 0) { await sleep(50); continue; }
    const claimed = await claim(o.kinds, free);
    if (claimed.length === 0) { await sleep(1000); continue; }
    // roster/memberlog jobs for seasons the API no longer serves would only earn HTTP 500s: park them, no API call
    const floor = oldestServedSeasonId();
    const expired = claimed.filter((j) => typeof j.payload?.seasonId === "number" && j.payload.seasonId < floor);
    if (expired.length) await parkJobs(expired.map((j) => j.id), `season outside API window (< ${floor})`);
    const jobs = expired.length ? claimed.filter((j) => !expired.includes(j)) : claimed;
    if (jobs.length === 0) continue;
    inflight += jobs.length;
    void (async () => {
      if (o.prefetch) { try { await cocPrefetch(jobs.flatMap((j) => o.prefetch!(j))); } catch { /* handlers fall back to single requests */ } }
      await Promise.all(jobs.map(run));
    })();
  }
  while (inflight > 0) await sleep(100);
}
