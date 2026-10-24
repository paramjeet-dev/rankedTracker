// Seeds the crawl queue.
//   npm run seed                              -> top clans of every country (+ global)
//   npm run seed -- '#TAG1' '#TAG2'           -> also queue specific players first (app users)
//   npm run seed -- --clans 200               -> clans per location (default 100)
//   npm run seed -- --no-clans '#TAG1'        -> only the given players
//
// Why clans and not player leaderboards: the player leaderboards only list Legend players, and Legend groups are
// skipped. Clans mix tiers, so one clan leaderboard entry reaches players from Titan to Electro, and each
// discovered group then spreads further through group-mates and their clans.
import { db, normTag } from './db.js';
import { client, loginCoc } from './coc.js';
import { enqueueMany } from './queue.js';
import { PRIO } from './ingest.js';

async function main() {
  const args = process.argv.slice(2);
  const perLoc = Number(args[args.indexOf('--clans') + 1] || 100) || 100;
  const noClans = args.includes('--no-clans');
  const tags = args.filter(a => a.startsWith('#') || /^[0-9A-Za-z]{5,}$/.test(a) && !/^\d+$/.test(a)).map(normTag);

  await loginCoc();

  if (tags.length) {
    await enqueueMany('profile', tags.map(t => ({ playerTag: t })), PRIO.appUser, true);
    console.log(`queued ${tags.length} priority player(s)`);
  }

  if (!noClans) {
    const { body: locs } = await client.rest.getLocations({ limit: 1000 });
    const ids: (number | string)[] = ['global', ...locs.items.filter(l => l.isCountry).map(l => l.id)];
    const seen = new Set<string>();
    for (const id of ids) {
      try {
        const { body } = await client.rest.getClanRanks(id, { limit: perLoc });
        for (const c of body.items) seen.add(c.tag);
      } catch (e: any) {
        console.warn(`location ${id}: ${e?.status ?? ''} ${e?.message ?? e}`);
      }
    }
    await enqueueMany('clan_members', [...seen].map(t => ({ clanTag: t })), PRIO.clanSeed);
    console.log(`queued ${seen.size} clans from ${ids.length} locations`);
  }
  await db.end();
}
main();
