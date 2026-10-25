// Post-rollover sweep: for a finished season, queue ONE group_fetch job per group that is not complete yet.
// Each job fetches members (most active first) until every battle of the group is stored.
// Auto-run by the crawler ~10 min after each Monday 05:00 UTC rollover; manual: npm run sweep -- <seasonId>
import { db } from './db.js';
import { enqueueMany } from './queue.js';
import { PRIO } from './ingest.js';

export async function sweepSeason(seasonId: string): Promise<number> {
  const { rows } = await db.query(
    `SELECT DISTINCT ON (g.group_tag) g.group_tag, g.tier_id, gm.player_tag
     FROM league_group g
     JOIN group_member gm ON gm.group_tag = g.group_tag AND gm.season_id = g.season_id
     WHERE g.season_id = $1 AND g.status <> 'complete'
     ORDER BY g.group_tag, gm.attack_wins + gm.attack_losses + gm.defense_wins + gm.defense_losses DESC, gm.player_tag`, [seasonId]);
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
    console.log(`sweep: season ${r.season_id} -> ${n} group jobs queued`);
  }
}

if (process.argv[1]?.endsWith('sweep.ts')) {
  const id = process.argv[2];
  if (!id) throw new Error('Usage: npm run sweep -- <seasonId>');
  sweepSeason(id).then(n => { console.log(`queued ${n} group jobs`); return db.end(); });
}
