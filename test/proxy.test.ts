import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { Client } from 'clashofclans.js';
import { fetch, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { applyOutboundProxy, buildDispatcher, describeProxy, proxyUrl } from '../src/shared/proxy.js';

// Throwaway self-signed certificate (test only) for api.clashofclans.com / developer.clashofclans.com.
const KEY = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC0aBkygyJLJ7be
OiiK7zFpejhG77Eg3mstnKSqoOk10JYHG6ALMoV/tBVQ2U+ROuNlDu32sa7VzP0b
WzFCdDz4zN0lpKmy7T8Q8C+wQgR8i59JbdYRJPQMX3NV48L27b22ATMp6MdFGe4j
DfLPxUJOX6/NozdIj/D7pPfhmvVE0BKGiFa+3t5dP7ckEHmOjxMTqJQsABrPFDkU
wAxJpnj6VKo6Zqp/Fjr99G/MXsETjjLSXEtJ2wVSg/UuO+F+oIa4eshsFkvMAAvN
b86+CWW8zGAPhXp29VOS9emRZWzLF8xGnkpgCJWjnmTEu0UMg4v+sCvbV+ovOGra
8QBbq1AdAgMBAAECggEAFukQaB6IpKA0xDiBDRHOxd0gV/vZE/pDBK4bqFKagzvL
zbfHpZxjIUJaoaOTS/d9SMhyVm2erSak7wwv74dI9fS4Ue89IMypwWorODhODw4B
KsdQ0+kMOCUIBdyQliC/gqVY3MXjxoYCPL/o+dNMdh0HO7dyThv/h8mdtDAkXTpT
owKEyv7qt2quLqcaVSkqOe+IUfHVp13JEYr0kJMxwZdzLeZqH+/ka8tC6BneMep2
J5zCryzsdV6/Wf7WSF7yUy7dihd67fOhIl4gSZzViAw+bdMFSNxg5iaHsYOZUi5X
VHqpNkmU7RrcnIXybS4PxTsVoUI8u4sRmCTDHpdPSQKBgQDmyAhmZ57ctX/K7BeW
n1Vy6aZ71mUbXR4jfNymuYyjh/rjJG0hWmgfkHybwumF2eUGUPcIPaLEjBF9BV4e
e/oVlsxE7dGRuciMMhwOKz1VmWOj1Hr5AdZbKMITBDH6Rn6HdkE7xPp8/co2S7s8
o0Hw6/WM7ss/4aebl+lnv7wXpQKBgQDIHtz11qux8sJD2zmQxs7JmeTdt0yXBv+d
LUbQfPfvTmcC2P304afUNvMgo5FZ9c8ovDWhS6RAbYQv/cw6bQ/RAuLR/d8wxcFx
SdqQf1KpB6X2P3DuFjdwW+LmgahGfEX9ATWMgQ37Z9FAtWi8/mRXilMe7sSpkk+C
9xMXiIEtGQKBgQCP57flM0QKWFrhjCqBT8WWrD+WBPBzCbObaWalyBn8dvRo4vPx
0lAPLqek8Ptw7Zg0QhRoXRa7/KODE+/GjoQ5Jhkl+i2t8u0tDqoT476RO9637+zm
jNC/c0DhXsJTT9XiXkj7Hi8b9Z08Eikk/KBHvLsXMGgo42sCSM3QVezRyQKBgAP4
OMHXpEg/XIMkEhxBFVECcHvFawuD5AYmI8V29SQWFg0EaOU2pLGc9W2sUPHL4nQY
Z6fvbC6q/XhGPIrcJvgqan1n38mD4rZwlJlRLT6VHEGqOH9AiZD9AZ846zGavXir
UXicBr757DiwYId/NFZYNBXk/pmugU1DwWkyF/3hAoGBAIC/+doMHY3XdCk5quZQ
iCjObeyI4OfLnYBNBEzwwO4ZLA4Oppm0Z+J5bN96cFyKT/JokshURIoBD0f8Segk
OQ1STvC6dCVemS8U2/TAyxBs9aZpL5gp6OiaX5GqhNCcNONPSEfThnbk9AO9fwRi
1k+UqKR6h6sReZ0KwdjroCGq
-----END PRIVATE KEY-----`;
const CERT = `-----BEGIN CERTIFICATE-----
MIIDbTCCAlWgAwIBAgIUDC0HY51nfKnVKQCwuf83699bGCkwDQYJKoZIhvcNAQEL
BQAwHzEdMBsGA1UEAwwUYXBpLmNsYXNob2ZjbGFucy5jb20wHhcNMjYxMDI5MDUz
MzU0WhcNMzYxMDI2MDUzMzU0WjAfMR0wGwYDVQQDDBRhcGkuY2xhc2hvZmNsYW5z
LmNvbTCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBALRoGTKDIksntt46
KIrvMWl6OEbvsSDeay2cpKqg6TXQlgcboAsyhX+0FVDZT5E642UO7faxrtXM/Rtb
MUJ0PPjM3SWkqbLtPxDwL7BCBHyLn0lt1hEk9Axfc1XjwvbtvbYBMynox0UZ7iMN
8s/FQk5fr82jN0iP8Puk9+Ga9UTQEoaIVr7e3l0/tyQQeY6PExOolCwAGs8UORTA
DEmmePpUqjpmqn8WOv30b8xewROOMtJcS0nbBVKD9S474X6ghrh6yGwWS8wAC81v
zr4JZbzMYA+Fenb1U5L16ZFlbMsXzEaeSmAIlaOeZMS7RQyDi/6wK9tX6i84atrx
AFurUB0CAwEAAaOBoDCBnTAdBgNVHQ4EFgQU7GPdnU0+DnSKST/rEEPzH9BmFvMw
HwYDVR0jBBgwFoAU7GPdnU0+DnSKST/rEEPzH9BmFvMwDwYDVR0TAQH/BAUwAwEB
/zBKBgNVHREEQzBBghRhcGkuY2xhc2hvZmNsYW5zLmNvbYIaZGV2ZWxvcGVyLmNs
YXNob2ZjbGFucy5jb22CDWFwaS5pcGlmeS5vcmcwDQYJKoZIhvcNAQELBQADggEB
AB/9BShCAsXHUrWjMliT7L5n9Us1HD2I0RgMOp774+xSRpbBjuQ1FO0Vokbd5wvV
G2AmbOlIw742fuvhNd9Op51cT02hJoHT5RfybWqMduIlKhs1qp33YFmn9vjj3y/y
pn1Ml4u/Hr5y6aZuY37Lz/s3G3KU2NndZ/bmInIJJIKUBy+T2MZ9AG38RpiFXU5c
HUsqT7YszL1DzfHPjr/9vzE2N07lNPX2sxSBd/UaucgCUK+WYPM/UmzjYIf8Zfkk
HpnNRIDucurvGkP1bVnAsqzykknzSVoACb6gJC8+aOY5peQmFo34LSZiFFuipB14
/F0MupjhZxQ64GAx00tzspE=
-----END CERTIFICATE-----`;

/** Fake Clash: answers on one local TLS port, whatever host the proxy was asked to reach. */
function fakeClash() {
  const seen: { host: string | undefined; path: string | undefined; auth: string | undefined }[] = [];
  const server = https.createServer({ key: KEY, cert: CERT }, (req, res) => {
    seen.push({ host: req.headers.host, path: req.url, auth: req.headers.authorization });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ items: [], ok: true }));
  });
  return { server, seen };
}

/** Minimal SOCKS5 server (no auth, CONNECT only) that records the requested host and tunnels to `target`. */
function fakeSocks(target: number) {
  const hosts: string[] = [];
  const server = net.createServer((c) => {
    c.once('data', () => {
      c.write(Buffer.from([5, 0]));
      c.once('data', (req) => {
        const atyp = req[3];
        let host = '', off = 4;
        if (atyp === 3) { const len = req[4]!; host = req.subarray(5, 5 + len).toString(); off = 5 + len; }
        else if (atyp === 1) { host = [...req.subarray(4, 8)].join('.'); off = 8; }
        hosts.push(`${host}:${req.readUInt16BE(off)}`);
        const up = net.connect(target, '127.0.0.1', () => {
          c.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
          c.pipe(up); up.pipe(c);
        });
        up.on('error', () => c.destroy());
      });
    });
    c.on('error', () => undefined);
  });
  return { server, hosts };
}

/** Minimal HTTP CONNECT proxy that records the requested host and tunnels to `target`. */
function fakeHttpProxy(target: number) {
  const hosts: string[] = [];
  const server = http.createServer();
  server.on('connect', (req, sock) => {
    hosts.push(req.url ?? '');
    const up = net.connect(target, '127.0.0.1', () => {
      sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      sock.pipe(up); up.pipe(sock);
    });
    up.on('error', () => sock.destroy());
    sock.on('error', () => up.destroy());
  });
  return { server, hosts };
}

const listen = (s: net.Server) => new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as net.AddressInfo).port)));
const close = (s: net.Server) => new Promise<void>((r) => s.close(() => r()));

async function withProxy(kind: 'socks' | 'http', fn: (ctx: { url: string; clash: ReturnType<typeof fakeClash>; hosts: string[] }) => Promise<void>) {
  const prevTls = process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
  const prevUrl = process.env['OUTBOUND_PROXY_URL'];
  const prevDispatcher = getGlobalDispatcher();
  process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0'; // the fake Clash uses a self-signed certificate
  const clash = fakeClash();
  const clashPort = await listen(clash.server);
  const proxy = kind === 'socks' ? fakeSocks(clashPort) : fakeHttpProxy(clashPort);
  const proxyPort = await listen(proxy.server);
  const url = `${kind === 'socks' ? 'socks5' : 'http'}://127.0.0.1:${proxyPort}`;
  process.env['OUTBOUND_PROXY_URL'] = url;
  try {
    await fn({ url, clash, hosts: proxy.hosts });
  } finally {
    setGlobalDispatcher(prevDispatcher);
    if (prevTls === undefined) delete process.env['NODE_TLS_REJECT_UNAUTHORIZED']; else process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = prevTls;
    if (prevUrl === undefined) delete process.env['OUTBOUND_PROXY_URL']; else process.env['OUTBOUND_PROXY_URL'] = prevUrl;
    await close(proxy.server); await close(clash.server);
  }
}

test('without OUTBOUND_PROXY_URL nothing is changed', () => {
  const prev = process.env['OUTBOUND_PROXY_URL'];
  delete process.env['OUTBOUND_PROXY_URL'];
  try {
    const client = new Client({ retryLimit: 0 });
    const before = (client.rest.requestHandler as unknown as { dispatcher: unknown }).dispatcher;
    assert.equal(proxyUrl(), null);
    assert.equal(applyOutboundProxy(client), false);
    assert.equal((client.rest.requestHandler as unknown as { dispatcher: unknown }).dispatcher, before);
  } finally {
    if (prev !== undefined) process.env['OUTBOUND_PROXY_URL'] = prev;
  }
});

for (const kind of ['socks', 'http'] as const) {
  test(`${kind}: API calls go through the proxy to api.clashofclans.com with the key`, { timeout: 20_000 }, async () => {
    await withProxy(kind, async ({ clash, hosts }) => {
      const client = new Client({ retryLimit: 0, restRequestTimeout: 5_000 });
      client.rest.requestHandler.setKeys(['test-key']);
      assert.equal(applyOutboundProxy(client), true);
      const res = await client.getLocations({ limit: 1 });
      assert.deepEqual(res, []);
      assert.deepEqual(clash.seen[0], { host: 'api.clashofclans.com', path: '/v1/locations?limit=1', auth: 'Bearer test-key' });
      assert.ok(hosts.includes('api.clashofclans.com:443'), `proxy saw ${JSON.stringify(hosts)}`);
    });
  });

  test(`${kind}: developer portal requests (login path) use the proxy too`, { timeout: 20_000 }, async () => {
    await withProxy(kind, async ({ clash, hosts }) => {
      applyOutboundProxy(new Client({ retryLimit: 0 }));
      const res = await fetch('https://developer.clashofclans.com/api/login', { method: 'POST', body: '{}' });
      assert.equal(res.status, 200);
      assert.equal(clash.seen[0]?.host, 'developer.clashofclans.com');
      assert.ok(hosts.includes('developer.clashofclans.com:443'), `proxy saw ${JSON.stringify(hosts)}`);
    });
  });

  test(`${kind}: 200 concurrent API calls all succeed`, { timeout: 40_000 }, async () => {
    await withProxy(kind, async ({ clash }) => {
      const client = new Client({ retryLimit: 0, restRequestTimeout: 10_000 });
      client.rest.requestHandler.setKeys(['k1', 'k2', 'k3']);
      applyOutboundProxy(client);
      const results = await Promise.allSettled(Array.from({ length: 200 }, () => client.getLocations({ limit: 1 })));
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 200);
      assert.equal(clash.seen.length, 200);
      assert.deepEqual(new Set(clash.seen.map((s) => s.auth)), new Set(['Bearer k1', 'Bearer k2', 'Bearer k3'])); // key rotation still works
    });
  });
}

test('proxy down: the failure is a network error the classifier treats as an outage', { timeout: 20_000 }, async () => {
  const prev = process.env['OUTBOUND_PROXY_URL'];
  const prevDispatcher = getGlobalDispatcher();
  const dead = net.createServer(); const port = await listen(dead); await close(dead); // a port nobody listens on
  process.env['OUTBOUND_PROXY_URL'] = `socks5://127.0.0.1:${port}`;
  try {
    const client = new Client({ retryLimit: 0, restRequestTimeout: 3_000 });
    client.rest.requestHandler.setKeys(['k']);
    applyOutboundProxy(client);
    const { classifyError } = await import('../src/shared/classify.js');
    const err = await client.getLocations({ limit: 1 }).then(() => null, (e: unknown) => e);
    assert.ok(err, 'expected a failure');
    const c = classifyError(err);
    assert.ok(c.closesGate || c.kind === 'timeout' || c.kind === 'server', `classified as ${c.kind}: ${(err as Error).message}`);
  } finally {
    setGlobalDispatcher(prevDispatcher);
    if (prev === undefined) delete process.env['OUTBOUND_PROXY_URL']; else process.env['OUTBOUND_PROXY_URL'] = prev;
  }
});

test('credentials in the proxy URL are never printed; bad schemes are rejected', () => {
  assert.equal(describeProxy('socks5://user:secret@10.0.0.1:1080'), 'socks5://10.0.0.1:1080');
  assert.throws(() => buildDispatcher('ftp://x:1'), /must start with/);
});
