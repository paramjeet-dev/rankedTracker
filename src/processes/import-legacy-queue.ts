import { importLegacyQueue } from '../discovery/seed.js';
import { createPg } from '../shared/db.js';
import { runProcess } from '../shared/process.js';

/** `npm run import-queue` shows what would be copied; `npm run import-queue -- --apply` copies it. */
void runProcess('import-queue', async ({ log }) => {
  const apply = process.argv.includes('--apply');
  const pg = createPg();
  try {
    const r = await importLegacyQueue(pg, apply);
    log.info(`queued clan_members jobs: ${r.clans.queued} tags, ${r.clans.missing} without a clan row`);
    log.info(`queued profile jobs: ${r.players.queued} tags, ${r.players.missing} without a player row`);
    if (apply) log.info(`inserted ${r.appliedClans} clans and ${r.appliedPlayers} players`);
    else log.info('dry run: nothing written. Add --apply to insert them.');
  } finally {
    await pg.end();
  }
});
