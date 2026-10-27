import { PgBattlesRepo } from '../battles/repo.js';
import { BattleCollector } from '../battles/run.js';
import { GroupStore } from '../groups/store.js';
import { createClashClient, ClashGateway } from '../shared/clash.js';
import { config, envNumber, poolConfig } from '../shared/config.js';
import { createPg } from '../shared/db.js';
import { AvailabilityGate } from '../shared/gate.js';
import { Metrics, startMetricsReporter } from '../shared/metrics.js';
import { Pacer } from '../shared/pacer.js';
import { runProcess } from '../shared/process.js';
import { loadScope } from '../shared/scope.js';
import { createValkey } from '../shared/valkey.js';

/** See docs/battles.md. */
void runProcess('battles', async ({ signal, log }) => {
  const workers = envNumber('BATTLES_WORKERS', 24);
  const pg = createPg(undefined, Math.max(envNumber('PG_POOL_MAX', 8), Math.min(workers, 24)));
  const valkey = createValkey();
  const scope = await loadScope(pg);
  const repo = new PgBattlesRepo(pg, { minTier: scope.min, maxTier: scope.max, seasonSeconds: config.seasonSeconds });

  const problem = await repo.sanityProblem();
  if (problem) throw new Error(problem);

  const budget = poolConfig('battles', { rps: 20, maxInFlight: 40 });
  const pacers = { battles: new Pacer({ rps: budget.rps, maxInFlight: budget.maxInFlight }) };

  const gate = new AvailabilityGate(valkey);
  gate.start();
  const metrics = new Metrics();
  const { client, relogin } = await createClashClient();
  const gateway = new ClashGateway({ client, gate, metrics, pacers, relogin });
  const stopReporter = startMetricsReporter({ processName: 'battles', metrics, pacers, valkey });

  const collector = new BattleCollector({
    repo,
    log,
    signal,
    store: new GroupStore(pg, config.seasonSeconds),
    pageSize: 200,
    idleMs: 60_000,
    fetchGroup: (t, playerTag, sig) =>
      gateway.call('battles', (c) => c.rest.getLeagueGroup(t.groupTag, t.seasonId, { playerTag }).then((r) => r.body), { signal: sig })
  });

  const progress = setInterval(async () => {
    try {
      const remaining = await repo.countTargets();
      const s = collector.stats;
      log.info(
        `remaining groups=${remaining} | settled: complete=${s.complete} incomplete=${s.incomplete} | calls=${s.calls} ` +
          `battlesInserted=${s.battlesInserted} paused=${s.paused} failed=${s.failed}`
      );
    } catch {
      /* progress is best effort */
    }
  }, 60_000);

  log.info(`${budget.rps} calls/s, ${workers} groups at a time; scope tiers ${scope.min}-${scope.max} (league_tier.in_scope)`);
  await collector.run(workers);

  clearInterval(progress);
  stopReporter();
  gate.stop();
  valkey.disconnect();
  await pg.end();
});
