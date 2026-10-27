import { insertSeedClans } from '../discovery/seed.js';
import { createClashClient, ClashGateway } from '../shared/clash.js';
import { createPg } from '../shared/db.js';
import { AvailabilityGate } from '../shared/gate.js';
import { Metrics } from '../shared/metrics.js';
import { Pacer } from '../shared/pacer.js';
import { runProcess } from '../shared/process.js';
import { createValkey } from '../shared/valkey.js';

/**
 * Seeds `clan` with the top clans of every country and the global ranking (replaces `npm run seed` for clans).
 *   npm run seed-clans                  -> 100 clans per location
 *   npm run seed-clans -- --clans 200
 * Why clans and not player leaderboards: player leaderboards only list Legend players and Legend groups are skipped;
 * a clan mixes tiers, so one ranked clan reaches players from Titan to Electro.
 */
void runProcess('seed-clans', async ({ log, signal }) => {
  const args = process.argv.slice(2);
  const perLoc = Number(args[args.indexOf('--clans') + 1] || 100) || 100;
  const pg = createPg();
  const valkey = createValkey();
  const gate = new AvailabilityGate(valkey);
  gate.start();
  const { client, relogin } = await createClashClient();
  const gateway = new ClashGateway({ client, gate, metrics: new Metrics(), pacers: { seed: new Pacer({ rps: 5, maxInFlight: 5 }) }, relogin });

  try {
    const locs = await gateway.call('seed', (c) => c.rest.getLocations({ limit: 1000 }).then((r) => r.body), { signal });
    if (!locs.ok) throw new Error(`could not list locations: ${locs.kind} ${locs.message}`);
    const ids: Array<number | string> = ['global', ...locs.value.items.filter((l) => l.isCountry).map((l) => l.id)];

    const seen = new Set<string>();
    for (const id of ids) {
      if (signal.aborted) break;
      const res = await gateway.call('seed', (c) => c.rest.getClanRanks(id, { limit: perLoc }).then((r) => r.body), { signal });
      if (!res.ok) {
        log.warn(`location ${id}: ${res.kind} ${res.message}`);
        continue;
      }
      for (const clan of res.value.items) seen.add(clan.tag);
    }
    const added = await insertSeedClans(pg, [...seen]);
    log.info(`${seen.size} clans from ${ids.length} locations; ${added} were new`);
  } finally {
    gate.stop();
    valkey.disconnect();
    await pg.end();
  }
});
