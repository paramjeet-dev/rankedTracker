// Smoke test: login, profile, league history, league group (with playerTag), tiers.
// Usage: npm run smoke -- '#PLAYERTAG'   (use a player currently in Titan-Electro)
import { loginCoc, client, getProfileRaw, getLeagueGroupForPlayer } from './coc.js';

async function main() {
  const tag = process.argv[2];
  if (!tag) throw new Error("Usage: npm run smoke -- '#PLAYERTAG'");

  await loginCoc();
  console.log('1. login ok');

  const p = await getProfileRaw(tag);
  console.log(`2. profile ok: ${p.name} (${p.tag})`);
  console.log(`   current group ${p.currentLeagueGroupTag} / season ${p.currentLeagueSeasonId}`);
  console.log(`   previous group ${p.previousLeagueGroupTag} / season ${p.previousLeagueSeasonId}`);

  const hist = await client.getLeagueHistory(tag);
  console.log(`3. league history ok: ${hist.length} seasons, oldest tier ${hist[0]?.leagueTierId} (${hist[0]?.leagueTrophies} trophies), latest finished tier ${hist.at(-1)?.leagueTierId} (${hist.at(-1)?.leagueTrophies} trophies)`);

  console.log(`   history season ids: ${hist.map((h) => h.leagueSeasonId).join(', ')}`);
  const iso = (sec: number) => new Date(sec * 1000).toISOString();
  console.log(`   now ${new Date().toISOString()} | current id decodes to ${iso(Number(p.currentLeagueSeasonId))} (season START; ends ${iso(Number(p.currentLeagueSeasonId) + 604800)})`);

  const tiers = await client.getLeaguesTiers();
  console.log(`4. league tiers ok: ${tiers.length} tiers`);

  if (p.currentLeagueGroupTag && p.currentLeagueSeasonId) {
    const g = await getLeagueGroupForPlayer(p.currentLeagueGroupTag, p.currentLeagueSeasonId, tag);
    console.log(`5. league group ok: ${g.members.length} members, ${g.attackLogs.length} attacks, ${g.defenseLogs.length} defenses logged for ${tag}`);
    const sumAttacks = g.members.reduce((s, m) => s + m.attackWinCount + m.attackLoseCount, 0);
    console.log(`   sum of roster attack counts (expected battles in group so far): ${sumAttacks}`);
  } else {
    console.log('5. player has no current league group (not in Ranked Mode this season?)');
  }
  console.log('ALL OK');
}
main().catch((e) => { console.error('FAILED:', e?.status ?? '', e?.message ?? e); process.exit(1); });
