// Checks the trophy rules against real data.   npm run trophies
//   attacker: 3 stars = 40, 2 stars = 16 + (destruction-50)/3, 1 star = 5 + (destruction-1)/9, 0 stars = min(4, destruction/10)
//   defender: 40 - attacker, except 0-star attacks where the defender gets 40
import { db } from './db.js';

async function main() {
  const q = async (sql: string) => (await db.query(sql)).rows;
  console.log('where the battle data came from');
  console.table(await q(`SELECT trophy_source, count(*)::int n FROM battle_resolved GROUP BY 1 ORDER BY 1`));

  console.log('defender rule on battles seen from BOTH sides (ok / bad), by stars');
  console.table(await q(`SELECT stars,
      count(*) FILTER (WHERE defender_trophies =  CASE WHEN stars = 0 THEN 40 ELSE 40 - attacker_trophies END)::int ok,
      count(*) FILTER (WHERE defender_trophies <> CASE WHEN stars = 0 THEN 40 ELSE 40 - attacker_trophies END)::int bad
      FROM battle WHERE attacker_trophies IS NOT NULL AND defender_trophies IS NOT NULL GROUP BY 1 ORDER BY 1`));
  console.log('defender rule: examples that break it');
  console.table(await q(`SELECT group_tag, season_id, attacker_tag, defender_tag, battle_time, stars, destruction, attacker_trophies, defender_trophies
      FROM battle WHERE attacker_trophies IS NOT NULL AND defender_trophies IS NOT NULL
        AND defender_trophies <> CASE WHEN stars = 0 THEN 40 ELSE 40 - attacker_trophies END LIMIT 15`));

  const expected = `CASE stars WHEN 3 THEN 40 WHEN 2 THEN 16 + GREATEST(destruction - 50, 0) / 3 WHEN 1 THEN 5 + GREATEST(destruction - 1, 0) / 9 ELSE LEAST(4, destruction / 10) END`;
  console.log('attacker formula (stars + destruction -> trophies), ok / bad');
  console.table(await q(`SELECT stars, count(*) FILTER (WHERE attacker_trophies = ${expected})::int ok,
      count(*) FILTER (WHERE attacker_trophies <> ${expected})::int bad FROM battle WHERE attacker_trophies IS NOT NULL GROUP BY 1 ORDER BY 1`));
  console.log('attacker formula: examples that break it');
  console.table(await q(`SELECT group_tag, season_id, attacker_tag, defender_tag, battle_time, stars, destruction, attacker_trophies, ${expected} AS formula
      FROM battle WHERE attacker_trophies IS NOT NULL AND attacker_trophies <> ${expected} LIMIT 15`));
  await db.end();
}
main();
