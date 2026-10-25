import type { Job } from './queue.js';
import { runProfile, runHistory, runClanMembers, runGroupFetch } from './ingest.js';

export async function handle(job: Job) {
  switch (job.kind) {
    case 'profile': return runProfile(job.payload);
    case 'history_backfill': return runHistory(job.payload);
    case 'clan_members': return runClanMembers(job.payload);
    case 'group_fetch': return runGroupFetch(job.payload);
    default: throw Object.assign(new Error(`unknown job kind ${job.kind}`), { status: 400 });
  }
}
