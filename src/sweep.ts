// Post-rollover sweep: re-fetch every member of every group of a finished season so battle logs are complete.
// Auto-run by the crawler ~10 min after each Monday 05:00 UTC rollover; can also be run by hand:
//   npm run sweep -- <seasonId>
import { db } from './db.js';
import { enqueueMany } from './queue.js';
import { PRIO } from './ingest.js';

export async function sweepSeason(seasonId: string): Promise<number> {
  const { rows } = await db.query(
    `SELECT gm.group_tag, gm.player_tag, g.tier_id
     FROM group_member gm
     JOIN league_group g ON g.group_tag = gm.group_tag AND g.season_id = gm.season_id
     JOIN season s ON s.season_id = gm.season_id
     WHERE gm.season_id = $1
       AND g.status <> 'complete'
       AND (gm.logs_fetched_at IS NULL OR gm.logs_fetched_at < s.ends_at)
       AND gm.attack_wins + gm.attack_losses + gm.defense_wins + gm.defense_losses > 0`, [seasonId]);
  await enqueueMany('group_fetch',
    rows.map(r => ({ groupTag: r.group_tag, seasonId, playerTag: r.player_tag, tierId: Number(r.tier_id) })),
    PRIO.sweep, true);
  await db.query('UPDATE season SET swept_at = now() WHERE season_id = $1', [seasonId]);
  return rows.length;
}

/** Sweep every finished season (ended > 10 min ago) that has groups and was not swept yet. */
export async function sweepDue(): Promise<void> {
  const { rows } = await db.query(
    `SELECT s.season_id FROM season s
     WHERE s.swept_at IS NULL AND s.ends_at < now() - interval '10 minutes'
       AND EXISTS (SELECT 1 FROM league_group g WHERE g.season_id = s.season_id)`);
  for (const r of rows) {
    const n = await sweepSeason(r.season_id);
    console.log(`sweep: season ${r.season_id} -> ${n} group_fetch jobs requeued`);
  }
}

if (process.argv[1]?.endsWith('sweep.ts')) {
  const id = process.argv[2];
  if (!id) throw new Error('Usage: npm run sweep -- <seasonId>');
  sweepSeason(id).then(n => { console.log(`requeued ${n}`); return db.end(); });
}
