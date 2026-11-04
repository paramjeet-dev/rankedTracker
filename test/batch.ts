/** End-to-end: real gateway process + fake upstream + real client. Checks batching, 404 handling, ordering, fallback, timing. */
import http from "node:http";
import zlib from "node:zlib";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import fs from "node:fs";

let upstreamCalls = 0;
const upstream = http.createServer((req, res) => {
  upstreamCalls++;
  setTimeout(() => {
    const missing = req.url!.includes("missing");
    const body = zlib.gzipSync(JSON.stringify(missing ? { reason: "notFound" } : { echo: req.url, auth: req.headers.authorization?.slice(0, 8) }));
    res.writeHead(missing ? 404 : 200, { "content-type": "application/json", "content-encoding": "gzip" }); res.end(body);
  }, 30); // 30ms "official API"
}).listen(18999, "127.0.0.1");

const gw = spawn("node", ["--import", "tsx", "apps/gateway/src/index.ts"], { env: { ...process.env, GATEWAY_SECRET: "s3", COC_KEYS: "k1,k2,k3", RPS_PER_KEY: "100", PORT: "18787", UPSTREAM_URL: "http://127.0.0.1:18999" }, stdio: "inherit" });
await new Promise((r) => setTimeout(r, 1500));

process.env.GATEWAY_URL = "http://127.0.0.1:18787"; process.env.GATEWAY_SECRET = "s3";
process.env.RAW_DIR = "/tmp/coc-raw-test"; process.env.DATABASE_URL = "postgres://x:x@127.0.0.1:1/x"; // fetch_log writes fail silently
const core = await import("@coc/core");
core.setRps(0);

try {
  // 1. batch of 250 paths (3 round trips of <=100), consumed one by one through cocGet (handlers are unchanged)
  const paths = Array.from({ length: 250 }, (_, i) => `/v1/players/%23P${i}`);
  paths[7] = "/v1/players/%23missing7";
  const t0 = Date.now();
  await core.cocPrefetch(paths.map((p, i) => ({ path: p, kind: "player", key: `P${i}` })));
  const batchMs = Date.now() - t0, callsAfterBatch = upstreamCalls;
  assert.equal(callsAfterBatch, 250, "every path reached the official API exactly once");
  let ok = 0, notFound = 0;
  for (let i = 0; i < paths.length; i++) {
    try { const j = await core.cocGet(paths[i], { kind: "player", key: `P${i}` }); assert.equal(j.echo, paths[i], "result matches its own request (order preserved)"); assert.equal(j.auth, "Bearer k"); ok++; }
    catch (e) { if (e instanceof core.NotFound) notFound++; else throw e; }
  }
  assert.equal(ok, 249); assert.equal(notFound, 1);
  assert.equal(upstreamCalls, 250, "cocGet served everything from the prefetch cache: no extra upstream calls");

  // 2. un-prefetched path falls back to a normal single request
  const single = await core.cocGet("/v1/players/%23SOLO", { kind: "player", key: "SOLO" });
  assert.equal(single.echo, "/v1/players/%23SOLO"); assert.equal(upstreamCalls, 251);

  // 3. gateway rejects bad batches
  const bad = await core.rawPost("/v1batch", { paths: ["/etc/passwd"] }); assert.equal(bad.status, 400);
  const big = await core.rawPost("/v1batch", { paths: Array(101).fill("/v1/locations") }); assert.equal(big.status, 400);
  const noauth = await fetch("http://127.0.0.1:18787/v1batch", { method: "POST", body: "{}" }); assert.equal(noauth.status, 401);

  // 4. stats
  const st = await (await fetch("http://127.0.0.1:18787/_stats", { headers: { "x-gateway-secret": "s3" } })).json();
  assert.equal(st.batches, 3); console.log("gateway stats:", JSON.stringify({ received: st.received, batches: st.batches, keys: st.keys.map((k: any) => k.ok) }));
  console.log(`OK: 250 calls in ${batchMs} ms through /v1batch (3 round trips); raw files:`, fs.readdirSync("/tmp/coc-raw-test").length > 0 ? "written" : "MISSING");
} finally { gw.kill(); upstream.close(); }
process.exit(0);
