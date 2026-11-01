import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import zlib from 'node:zlib';
import type { Client } from 'clashofclans.js';
import { ClashGateway, GatewayKeysError, createClashClient, createLoginClient, type KeyManagerLike } from '../src/shared/clash.js';
import { Metrics } from '../src/shared/metrics.js';
import { Pacer } from '../src/shared/pacer.js';
import type { AvailabilityGate } from '../src/shared/gate.js';
import type { KV } from '../src/shared/keys.js';

const PAYLOAD = JSON.stringify({ items: Array.from({ length: 200 }, (_, i) => ({ id: i, name: `Location ${i}`, isCountry: true })) });
const kv: KV = { get: async () => null, set: async () => undefined, del: async () => undefined };

/** Stands in for ClashKingProxy: plain HTTP, /v1/* forwarded, its own key replaces Authorization, gzip passed through. */
function fakeGateway(opts: { reject?: boolean } = {}) {
  const seen: { url?: string; auth?: string; ae?: string }[] = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization, ae: req.headers['accept-encoding'] as string | undefined });
    res.setHeader('content-type', 'application/json');
    if (opts.reject) { res.statusCode = 403; res.end(JSON.stringify({ reason: 'accessDenied.invalidIp', message: 'Invalid authorization' })); return; }
    const gz = String(req.headers['accept-encoding'] ?? '').includes('gzip');
    const body = gz ? zlib.gzipSync(PAYLOAD) : Buffer.from(PAYLOAD);
    if (gz) res.setHeader('content-encoding', 'gzip');
    res.end(body);
  });
  return { server, seen };
}
const listen = (s: net.Server) => new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as net.AddressInfo).port)));
const close = (s: net.Server) => new Promise<void>((r) => s.close(() => r()));

async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) { prev[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]!; }
  try { return await fn(); } finally { for (const k of Object.keys(prev)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]!; } }
}

test('gateway mode: requests go to CLASH_BASE_URL with a placeholder key and compression, no login needed', { timeout: 20_000 }, async () => {
  const gw = fakeGateway(); const port = await listen(gw.server);
  try {
    await withEnv({ CLASH_BASE_URL: `http://127.0.0.1:${port}/v1`, CLASH_EMAIL: undefined, CLASH_PASSWORD: undefined, COC_EMAIL: undefined, COC_PASSWORD: undefined, OUTBOUND_PROXY_URL: undefined, CLASH_COMPRESSION: undefined }, async () => {
      const { client, relogin } = await createClashClient(kv);
      const res = await client.getLocations({ limit: 1 });
      assert.equal(res.length, 200);
      assert.equal(gw.seen[0]?.url, '/v1/locations?limit=1');
      assert.equal(gw.seen[0]?.auth, 'Bearer via-gateway');
      assert.equal(gw.seen[0]?.ae, 'gzip, deflate');
      await assert.rejects(relogin(), GatewayKeysError);
    });
  } finally { await close(gw.server); }
});

test('gateway mode: availability gets a client and a no-op key manager (nothing to log in to)', { timeout: 20_000 }, async () => {
  const gw = fakeGateway(); const port = await listen(gw.server);
  try {
    await withEnv({ CLASH_BASE_URL: `http://127.0.0.1:${port}/v1/`, CLASH_EMAIL: undefined, CLASH_PASSWORD: undefined, COC_EMAIL: undefined, COC_PASSWORD: undefined }, async () => {
      const { client, manager } = await createLoginClient(kv, true);
      const m: KeyManagerLike = manager;
      await m.relogin('probe was rejected');
      assert.equal(await m.pollRefresh(), false);
      assert.equal(m.currentVersion, 0);
      assert.equal((await client.getLocations({ limit: 1 })).length, 200); // trailing slash in the URL is tolerated
    });
  } finally { await close(gw.server); }
});

test('gateway mode: rejected keys close the gate and do NOT reopen it (the keys are on the gateway)', { timeout: 20_000 }, async () => {
  const gw = fakeGateway({ reject: true }); const port = await listen(gw.server);
  try {
    await withEnv({ CLASH_BASE_URL: `http://127.0.0.1:${port}/v1` }, async () => {
      const { client, relogin } = await createClashClient(kv);
      const events: string[] = [];
      const gate = {
        isOpen: true,
        waitOpen: async () => undefined,
        close: (why: string) => void events.push(`close:${why}`),
        reopen: (why: string) => void events.push(`reopen:${why}`)
      } as unknown as AvailabilityGate;
      const gateway = new ClashGateway({ client: client as Client, gate, metrics: new Metrics(), pacers: { p: new Pacer({ rps: 1000, maxInFlight: 4 }) }, relogin });
      const res = await gateway.call('p', (c) => c.getLocations({ limit: 1 }), { maxGateRetries: 0 });
      assert.equal(res.ok, false);
      await new Promise((r) => setTimeout(r, 50));
      assert.ok(events.includes('close:auth'), JSON.stringify(events));
      assert.ok(!events.some((e) => e.startsWith('reopen')), `gate must stay closed, saw ${JSON.stringify(events)}`);
    });
  } finally { await close(gw.server); }
});

test('without CLASH_BASE_URL the config reports no gateway', () => {
  return withEnv({ CLASH_BASE_URL: undefined }, async () => {
    const { config } = await import('../src/shared/config.js');
    assert.equal(config.clash.baseUrl, null);
  });
});
