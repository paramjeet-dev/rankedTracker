import { fetch } from 'undici';
import { config } from '../shared/config.js';
import { describeProxy, egressIp, proxyUrl } from '../shared/proxy.js';

/**
 * `npm run egress`: checks the path to the Clash API.
 *  - gateway mode (CLASH_BASE_URL): is the gateway reachable, and does a real API call through it succeed (keys valid)?
 *  - otherwise: prints the IP Clash will see; with OUTBOUND_PROXY_URL it must be the VPS address.
 */
async function gatewayCheck(base: string): Promise<boolean> {
  const origin = new URL(base).origin;
  console.log(`gateway: ${origin}   (API base ${base})`);
  try {
    const root = await fetch(`${origin}/`, { signal: AbortSignal.timeout(8_000) });
    console.log(`  gateway answers: HTTP ${root.status} ${(await root.text()).slice(0, 80)}`);
  } catch (err) {
    console.error(`  cannot reach the gateway (is the tunnel running?): ${(err as Error).message}`);
    return false;
  }
  const t0 = Date.now();
  const res = await fetch(`${base}/locations?limit=1`, { headers: { authorization: 'Bearer placeholder', 'accept-encoding': 'gzip' }, signal: AbortSignal.timeout(15_000) });
  const text = await res.text();
  console.log(`  API call through the gateway: HTTP ${res.status} in ${Date.now() - t0} ms${res.status === 200 ? ' (keys are valid)' : ' ' + text.slice(0, 120)}`);
  try {
    const stats = await fetch(`${origin}/stats`, { signal: AbortSignal.timeout(8_000) });
    console.log(`  gateway stats: ${(await stats.text()).slice(0, 600)}`);
  } catch { /* stats are optional */ }
  return res.status === 200;
}

const gatewayBase = config.clash.baseUrl;
const url = proxyUrl();
try {
  if (gatewayBase) {
    process.exit((await gatewayCheck(gatewayBase)) ? 0 : 1);
  }
  console.log(url ? `proxy: ${describeProxy(url)}` : 'proxy: none (direct connection)');
  console.log(`egress IP: ${await egressIp()}`);
  process.exit(0);
} catch (err) {
  console.error(`check failed${url ? ' (is the tunnel running?)' : ''}: ${(err as Error).message}`);
  process.exit(1);
}
