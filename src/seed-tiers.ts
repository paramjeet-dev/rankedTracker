// Seeds league_tier from the API (ids and names). Idempotent.
import pg from 'pg';
import 'dotenv/config';
import { client, loginCoc } from './coc.js';

// Tracking scope: Titan League 26 .. Electro League 33
const SCOPE_MIN = 105000026;
const SCOPE_MAX = 105000033;

async function main() {
  await loginCoc();
  const tiers = await client.getLeaguesTiers();
  const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  for (const t of tiers) {
    await db.query(
      `INSERT INTO league_tier (tier_id, name) VALUES ($1,$2)
       ON CONFLICT (tier_id) DO UPDATE SET name = EXCLUDED.name`,
      [t.id, t.name]
    );
    console.log(`${t.id}  ${t.name}`);
  }
  await db.query('UPDATE league_tier SET in_scope = tier_id BETWEEN $1 AND $2', [SCOPE_MIN, SCOPE_MAX]);
  await db.end();
  console.log(`seeded ${tiers.length} tiers`);
}
main();
