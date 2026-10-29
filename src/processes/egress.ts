import { describeProxy, egressIp, proxyUrl } from '../shared/proxy.js';

/** `npm run egress`: prints the IP address Clash will see. With OUTBOUND_PROXY_URL it must be the VPS address. */
const url = proxyUrl();
console.log(url ? `proxy: ${describeProxy(url)}` : 'proxy: none (direct connection)');
try {
  console.log(`egress IP: ${await egressIp()}`);
  process.exit(0);
} catch (err) {
  console.error(`could not reach the internet${url ? ' through the proxy (is the tunnel running?)' : ''}: ${(err as Error).message}`);
  process.exit(1);
}
