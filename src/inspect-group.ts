// Re-fetches ONE group from the API for every member and lists battles whose two logs break the trophy rules.
// Read-only: does not write to the database. Works with the old or the new schema.
//
//   npm run inspect -- <groupTag> [seasonId] [playerTag]
//   npm run inspect -- '#8VVJ92G' 1792386000
//
// If playerTag is omitted it is taken from the database (group_member) for that group.
import fs from 'node:fs';
import { loginCoc, getLeagueGroupForPlayer } from './coc.js';
import { normTag } from './db.js';

async function main() {
  const [groupArg, seasonArg, playerArg] = process.argv.slice(2);
  if (!groupArg) throw new Error("Usage: npm run inspect -- '<groupTag>' [seasonId] [playerTag]");
  const groupTag = normTag(groupArg);
  let seasonId = seasonArg;
  let startPlayer = playerArg ? normTag(playerArg) : undefined;

  if (!seasonId || !startPlayer) {
    const { db } = await import('./db.js');
    const { rows } = await db.query(
      `SELECT season_id, player_tag FROM group_member WHERE group_tag = $1 ${seasonId ? 'AND season_id = $2' : ''}
       ORDER BY season_id DESC, attack_wins + attack_losses DESC LIMIT 1`, seasonId ? [groupTag, seasonId] : [groupTag]);
    await db.end();
    if (!rows.length) throw new Error('Group not in the database. Pass seasonId and playerTag explicitly.');
    seasonId = seasonId ?? rows[0].season_id;
    startPlayer = startPlayer ?? rows[0].player_tag;
  }

  await loginCoc();
  const first = await getLeagueGroupForPlayer(groupTag, seasonId!, startPlayer!);
  const members = first.members ?? [];
  console.log(`group ${groupTag} season ${seasonId}: ${members.length} members`);

  type Side = { trophies: number; stars: number; destruction: number; time: string };
  const att = new Map<string, Side>();   // seen in the attacker's attack log
  const def = new Map<string, Side>();   // seen in the defender's defense log
  const key = (a: string, d: string, t: string) => `${a}|${d}|${t}`;

  const queue = members.filter(m => m.attackWinCount + m.attackLoseCount + m.defenseWinCount + m.defenseLoseCount > 0).map(m => m.playerTag);
  const worker = async () => {
    for (let tag = queue.pop(); tag; tag = queue.pop()) {
      const r = tag === startPlayer ? first : await getLeagueGroupForPlayer(groupTag, seasonId!, tag);
      for (const a of r.attackLogs ?? [])
        att.set(key(tag, a.opponentPlayerTag, a.creationTime), { trophies: a.trophies, stars: a.stars, destruction: a.destructionPercentage, time: a.creationTime });
      for (const d of r.defenseLogs ?? [])
        def.set(key(d.opponentPlayerTag, tag, d.creationTime), { trophies: d.trophies, stars: d.stars, destruction: d.destructionPercentage, time: d.creationTime });
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));

  const out: any[] = [];
  let both = 0, onlyAtt = 0, onlyDef = 0;
  for (const [k, a] of att) {
    const d = def.get(k);
    if (!d) { onlyAtt++; continue; }
    both++;
    const [attacker, defender] = k.split('|');
    const sum = a.trophies + d.trophies;
    const ruleOk = d.trophies === (a.stars === 0 ? 40 : 40 - a.trophies); // 0-star attacks: defender gets the full 40
    if (!ruleOk || a.stars !== d.stars || a.destruction !== d.destruction)
      out.push({ groupTag, seasonId, attacker, defender, creationTime: a.time, starsAtt: a.stars, starsDef: d.stars,
                 destAtt: a.destruction, destDef: d.destruction, attackerLogTrophies: a.trophies, defenderLogTrophies: d.trophies, sum });
  }
  for (const k of def.keys()) if (!att.has(k)) onlyDef++;

  console.log(`battles seen from both sides: ${both}, only in attacker's log: ${onlyAtt}, only in defender's log: ${onlyDef}`);
  console.log(`disagreements (defender rule broken, or stars/destruction differ): ${out.length}`);
  if (out.length) console.table(out);
  const file = `inspect-${groupTag.replace('#', '')}-${seasonId}.json`;
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`saved ${file}`);
}
main().catch(e => { console.error(e?.message ?? e); process.exit(1); });
