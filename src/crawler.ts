// The crawler. Runs forever on your PC; safe to stop (Ctrl+C) and restart, the queue lives in Postgres.
//   npm run crawl
import { db } from './db.js';
import { loginCoc } from './coc.js';
import { claim, complete, fail, recoverStale, isRetryable, Job } from './queue.js';
import { loadScope, runProfile, runHistory, runClanMembers, runGroupFetch, finalizeGroup, stats } from './ingest.js';
import { sweepDue } from './sweep.js';

const CONCURRENCY = Number(process.env.CRAWL_CONCURRENCY ?? 32);
let stopping = false;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function handle(job: Job) {
  switch (job.kind) {
    case 'profile': return runProfile(job.payload);
    case 'history_backfill': return runHistory(job.payload);
    case 'clan_members': return runClanMembers(job.payload);
    case 'group_fetch': return runGroupFetch(job.payload);
    default: throw Object.assign(new Error(`unknown job kind ${job.kind}`), { status: 400 });
  }
}

async function worker(n: number) {
  while (!stopping) {
    const job = await claim();
    if (!job) { await sleep(2000); continue; }
    let terminal = true;
    try {
      await handle(job);
      await complete(job.id);
    } catch (e: any) {
      const retried = await fail(job, `${e?.status ?? ''} ${e?.message ?? e}`, isRetryable(e));
      terminal = !retried;
      console.warn(`[w${n}] ${job.kind} #${job.id} ${retried ? 'retry' : 'FAILED'}: ${e?.status ?? ''} ${e?.message ?? e}`);
    }
    if (terminal && job.kind === 'group_fetch') {
      await finalizeGroup(job.payload.groupTag, job.payload.seasonId).catch(() => {});
    }
  }
}

async function report() {
  const { rows } = await db.query(`SELECT kind, status, count(*)::int n FROM job GROUP BY 1,2 ORDER BY 1,2`);
  const line = rows.map(r => `${r.kind}:${r.status}=${r.n}`).join('  ') || 'queue empty';
  console.log(`[${new Date().toISOString()}] ${line} | battles+${stats.battlesInserted} mismatches=${stats.trophyMismatch}`);
}

async function main() {
  await loginCoc();
  await loadScope();
  const n = await recoverStale();
  if (n) console.log(`recovered ${n} interrupted jobs`);
  const { rows } = await db.query(`SELECT count(*)::int n FROM job WHERE status='queued'`);
  if (!rows[0].n) console.log('Queue is empty. Run: npm run seed');

  process.on('SIGINT', () => { console.log('stopping after current jobs...'); stopping = true; });
  process.on('SIGTERM', () => { stopping = true; });

  const timer = setInterval(() => { report().catch(() => {}); }, 30_000);
  const sweeper = setInterval(() => { sweepDue().catch(e => console.warn('sweep error', e?.message)); }, 60_000);
  await sweepDue();

  await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(i + 1)));
  clearInterval(timer); clearInterval(sweeper);
  await report();
  await db.end();
}
main();
