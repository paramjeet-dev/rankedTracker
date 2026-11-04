// Run ON THE VPS (no dependencies): node bench-vps.mjs <SECRET> [bench-paths.json] [http://127.0.0.1:8787]
// Same sweeps as `npm run bench`, but without the tunnel: shows what the VPS <-> official API path can really do.
import http from "node:http"; import fs from "node:fs";
const [secret, pathsFile = "bench-paths.json", base = "http://127.0.0.1:8787"] = process.argv.slice(2);
if (!secret) { console.log("usage: node bench-vps.mjs <SECRET> [bench-paths.json] [gateway url]"); process.exit(1); }
const agent = new http.Agent({ keepAlive: true, maxSockets: 256 });
const call = (method, path, body) => new Promise((resolve, reject) => {
  const u = new URL(path, base); const h = { "x-gateway-secret": secret, "accept-encoding": "gzip" };
  if (body) { h["content-type"] = "application/json"; h["content-length"] = Buffer.byteLength(body); }
  const r = http.request(u, { method, agent, headers: h, timeout: 60000 }, (res) => { let n = 0; res.on("data", (c) => (n += c.length)); res.on("end", () => resolve({ status: res.statusCode, bytes: n })); });
  r.on("error", reject); r.on("timeout", () => r.destroy(new Error("timeout"))); if (body) r.write(body); r.end();
});
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))] ?? 0; };
async function sweep(name, mk, levels, seconds = 8, per = 1) {
  console.log(`\n== ${name}`); const rows = [];
  for (const c of levels) {
    const ms = []; let ok = 0, err = 0, bytes = 0, i = 0; const end = Date.now() + seconds * 1000;
    await Promise.all(Array.from({ length: c }, async () => { while (Date.now() < end) { const t0 = Date.now(); try { const r = await mk(i++); if (r.status === 200) { ok += per; bytes += r.bytes; ms.push(Date.now() - t0); } else err++; } catch { err++; } } }));
    rows.push({ concurrency: c, api_calls_per_s: +(ok / seconds).toFixed(1), p50_ms: pct(ms, 0.5), p95_ms: pct(ms, 0.95), MB_per_s: +(bytes / seconds / 1e6).toFixed(2), errors: err });
  }
  console.table(rows);
}
await sweep("ping (/_stats, VPS-local)", () => call("GET", "/_stats"), [1, 8, 32]);
await sweep("locations (tiny official call)", () => call("GET", "/v1/locations?limit=1"), [1, 4, 16, 32]);
if (fs.existsSync(pathsFile)) {
  const paths = JSON.parse(fs.readFileSync(pathsFile, "utf8"));
  await sweep("group payloads, one per request", (i) => call("GET", paths[i % paths.length]), [1, 4, 16, 32]);
  await sweep("group payloads, batched x50", (i) => call("POST", "/v1batch", JSON.stringify({ paths: Array.from({ length: 50 }, (_, k) => paths[(i * 50 + k) % paths.length]) })), [1, 2, 4], 10, 50);
} else console.log(`(no ${pathsFile}: skipping group sweeps; create it locally with npm run bench:export)`);
