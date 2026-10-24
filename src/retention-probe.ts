// Spike E: record whether old groups are still fetchable. Run now, and again after each Monday rollover.
// Usage: npm run probe -- '#PLAYER1' '#PLAYER2' ...
import pg from 'pg';
import { loginCoc, getProfileRaw, getLeagueGroupForPlayer } from './coc.js';

const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const tags = process.argv.slice(2);
  if (!tags.length) throw new Error('Pass at least one player tag');
  await loginCoc();

  for (const tag of tags) {
    const p = await getProfileRaw(tag);
    const targets = [
      [p.currentLeagueGroupTag, p.currentLeagueSeasonId],
      [p.previousLeagueGroupTag, p.previousLeagueSeasonId]
    ] as const;
    for (const [group, season] of targets) {
      if (!group || !season) continue;
      let status = 200, ok = true;
      try {
        await getLeagueGroupForPlayer(group, season, tag);
      } catch (e: any) {
        ok = false;
        status = e?.status ?? 0;
        console.error(`probe failed ${group}/${season}:`, e?.message ?? e);
      }
      await db.query(
        `INSERT INTO retention_probe (group_tag, season_id, http_status, ok) VALUES ($1,$2,$3,$4)`,
        [group, String(season), status, ok]
      );
      console.log(`${group} season ${season}: ${ok ? 'ok' : 'FAILED ' + status}`);
    }
  }
  await db.end();
}
main();
