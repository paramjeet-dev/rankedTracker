// npm run stats
import { db } from './db.js';

async function main() {
  const q = async (sql: string) => (await db.query(sql)).rows;
  console.log('jobs');            console.table(await q(`SELECT kind, status, count(*)::int n FROM job GROUP BY 1,2 ORDER BY 1,2`));
  console.log('groups by season'); console.table(await q(`SELECT season_id, status, count(*)::int groups, sum(stored_battles)::int stored, sum(expected_battles)::int expected FROM league_group GROUP BY 1,2 ORDER BY 1 DESC,2`));
  console.log('groups by tier');  console.table(await q(`SELECT t.name, count(*)::int groups FROM league_group g JOIN league_tier t USING (tier_id) GROUP BY 1 ORDER BY min(g.tier_id)`));
  console.log('totals');          console.table(await q(`SELECT (SELECT count(*) FROM player)::int players, (SELECT count(*) FROM clan)::int clans, (SELECT count(*) FROM battle)::int battles, (SELECT count(*) FROM player_season_result)::int season_results, pg_size_pretty(pg_database_size(current_database())) db_size`));
  console.log('recent failures'); console.table(await q(`SELECT kind, payload, last_error FROM job WHERE status='failed' ORDER BY updated_at DESC LIMIT 5`));
  await db.end();
}
main();
