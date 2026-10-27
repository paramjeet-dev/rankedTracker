import { AVAILABILITY_KEY, EVENTS_STREAM } from '../shared/availability-state.js';
import { createClashClient } from '../shared/clash.js';
import { config } from '../shared/config.js';
import { AvailabilityController } from '../shared/controller.js';
import { runProcess } from '../shared/process.js';
import { sleep } from '../shared/util.js';
import { createValkey } from '../shared/valkey.js';

/** See docs/availability.md. The only process that writes the shared availability state. */
void runProcess('availability', async ({ signal, log }) => {
  const valkey = createValkey();
  const { client, relogin } = await createClashClient();

  const controller = new AvailabilityController({
    probe: () => client.getLocations({ limit: 1 }),
    relogin,
    publish: async (state) => {
      await valkey.set(AVAILABILITY_KEY, JSON.stringify(state), 'EX', config.availability.stateTtlSeconds);
    },
    emit: async (type, fields) => {
      await valkey.xadd(EVENTS_STREAM, 'MAXLEN', '~', 10_000, '*', 'type', type, ...Object.entries(fields).flat().map(String));
    }
  });

  log.info(`probing every ${config.availability.probeIntervalMs / 1000}s`);
  while (!signal.aborted) {
    try {
      await controller.tick();
    } catch (err) {
      log.error('tick failed (state not published this round)', err);
    }
    if (!(await sleep(config.availability.probeIntervalMs, signal))) break;
  }
  valkey.disconnect();
});
