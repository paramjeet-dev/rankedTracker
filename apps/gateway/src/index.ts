/**
 * API gateway for the VPS (static IP). Holds all keys, enforces per-key rate limits and forwards to api.clashofclans.com.
 *  GET  /v1/*       streams one upstream response through untouched (gzip stays gzip)
 *  POST /v1batch    {"paths":[...<=100 /v1/ paths]} -> one response carrying every result (bodies base64 of the upstream gzip bytes).
 *                   One round trip for up to 100 API calls: this is what makes a slow/jittery link to the workers usable.
 *  GET  /_stats     counters and timing
 */
import http from "node:http";
import https from "node:https";
import { timingSafeEqual } from "node:crypto";

const SECRET = process.env.GATEWAY_SECRET ?? "";
const KEYS = (process.env.COC_KEYS ?? "").split(",").map((k) => k.trim()).filter(Boolean);
const RPS = Number(process.env.RPS_PER_KEY ?? 15);
const MAX_QUEUE = Number(process.env.MAX_QUEUE ?? 3000);
const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "127.0.0.1"; // keep on localhost; expose via SSH tunnel or a TLS reverse proxy
const UP = new URL(process.env.UPSTREAM_URL ?? "https://api.clashofclans.com");
const upMod = UP.protocol === "https:" ? https : http;
const PATH_RE = /^\/v1\/[A-Za-z0-9%/_.\-?=&]*$/;
if (!SECRET || KEYS.length === 0) throw new Error("GATEWAY_SECRET and COC_KEYS are required");

interface KeyState { id: number; key: string; nextAt: number; cooldownUntil: number; disabled: boolean; ok: number; throttled: number; errors: number }
const keys: KeyState[] = KEYS.map((key, id) => ({ id, key, nextAt: 0, cooldownUntil: 0, disabled: false, ok: 0, throttled: 0, errors: 0 }));
const interval = 1000 / RPS;

interface Result { status: number; body: Buffer; encoding?: string; keyId: number; queueMs: number; ttfbMs: number; retryAfter?: number }
interface Job { path: string; enqueuedAt: number; res?: http.ServerResponse; acceptEncoding?: string; cb?: (r: Result) => void }
const queue: Job[] = [];
let timer: NodeJS.Timeout | null = null;
const stats = { received: 0, batches: 0, rejectedFull: 0, upstream429: 0, aborted: 0, started: Date.now() };
const recent: number[] = []; // total ms per finished single response

const authed = (req: http.IncomingMessage) => {
  const given = Buffer.from(String(req.headers["x-gateway-secret"] ?? ""));
  const want = Buffer.from(SECRET);
  return given.length === want.length && timingSafeEqual(given, want);
};

function pump() {
  if (timer) { clearTimeout(timer); timer = null; }
  while (queue.length) {
    const live = keys.filter((k) => !k.disabled);
    if (live.length === 0) { while (queue.length) fail(queue.shift()!, 503, "no usable keys"); return; }
    const k = live.reduce((a, b) => (Math.max(a.nextAt, a.cooldownUntil) <= Math.max(b.nextAt, b.cooldownUntil) ? a : b));
    const ready = Math.max(k.nextAt, k.cooldownUntil);
    if (ready > Date.now()) { timer = setTimeout(pump, ready - Date.now()); return; }
    const job = queue.shift()!;
    if (job.res && (job.res.destroyed || job.res.writableEnded)) continue; // client gave up while queued
    k.nextAt = Math.max(Date.now(), k.nextAt) + interval;
    dispatch(job, k);
  }
}

function fail(job: Job, status: number, msg: string, retryAfter?: number) {
  const body = JSON.stringify({ reason: "gateway", message: msg });
  if (job.cb) { job.cb({ status, body: Buffer.from(body), keyId: -1, queueMs: Date.now() - job.enqueuedAt, ttfbMs: 0, retryAfter }); return; }
  if (!job.res || job.res.headersSent) return;
  job.res.writeHead(status, { "content-type": "application/json", ...(retryAfter ? { "retry-after": String(retryAfter) } : {}) });
  job.res.end(body);
}

function dispatch(job: Job, k: KeyState) {
  const queuedMs = Date.now() - job.enqueuedAt, t0 = Date.now();
  const up = upMod.request(
    { host: UP.hostname, port: UP.port || undefined, path: job.path, method: "GET", timeout: 15000,
      headers: { authorization: `Bearer ${k.key}`, accept: "application/json", "accept-encoding": job.acceptEncoding ?? "gzip" } },
    (r) => {
      const status = r.statusCode ?? 502;
      if (status === 429) { k.throttled++; stats.upstream429++; k.cooldownUntil = Date.now() + 2000; }
      else if (status === 403 && !job.path.includes("/leaguegroup")) { k.errors++; } // 403 may be a bad key/IP; see /_stats
      else if (status < 500) k.ok++;
      const ttfbMs = Date.now() - t0;
      if (job.cb) { // batch member: buffer the (small, still gzipped) body
        const chunks: Buffer[] = [];
        r.on("data", (c) => chunks.push(c));
        r.on("end", () => job.cb!({ status, body: Buffer.concat(chunks), encoding: r.headers["content-encoding"] as string | undefined, keyId: k.id, queueMs: queuedMs, ttfbMs, retryAfter: r.headers["retry-after"] ? Number(r.headers["retry-after"]) : undefined }));
        r.on("error", () => fail(job, 502, "upstream stream error", 1));
        return;
      }
      const h: http.OutgoingHttpHeaders = { "x-key-id": String(k.id), "x-queue-ms": String(queuedMs), "x-ttfb-ms": String(ttfbMs) };
      for (const n of ["content-type", "content-encoding", "cache-control", "retry-after"]) if (r.headers[n]) h[n] = r.headers[n];
      job.res!.writeHead(status, h);
      r.pipe(job.res!);
    },
  );
  up.on("timeout", () => up.destroy(new Error("upstream timeout")));
  up.on("error", () => { k.errors++; fail(job, 502, "upstream error", 1); });
  up.end();
}

async function handleBatch(req: http.IncomingMessage, res: http.ServerResponse) {
  const chunks: Buffer[] = []; let size = 0;
  for await (const c of req) { size += (c as Buffer).length; if (size > 262_144) { res.writeHead(413).end(); return; } chunks.push(c as Buffer); }
  let paths: unknown;
  try { paths = JSON.parse(Buffer.concat(chunks).toString("utf8")).paths; } catch { res.writeHead(400).end(); return; }
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > 100 || paths.some((p) => typeof p !== "string" || !PATH_RE.test(p) || p.includes(".."))) { res.writeHead(400).end(); return; }
  if (queue.length + paths.length > MAX_QUEUE) { stats.rejectedFull++; res.writeHead(503, { "retry-after": "2", "content-type": "application/json" }).end(JSON.stringify({ reason: "gateway", message: "queue full" })); return; }
  stats.received += paths.length; stats.batches++;
  const t0 = Date.now();
  const pending = (paths as string[]).map((path) => new Promise<Result>((resolve) => { queue.push({ path, enqueuedAt: Date.now(), cb: resolve }); }));
  pump();
  const results = await Promise.all(pending);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ms: Date.now() - t0, results: results.map((r) => ({ status: r.status, enc: r.encoding === "gzip" ? "gzip" : "identity", key: r.keyId, queueMs: r.queueMs, ttfbMs: r.ttfbMs, retryAfter: r.retryAfter, body: r.body.toString("base64") })) }));
}

const server = http.createServer((req, res) => {
  if (!authed(req)) { res.writeHead(401).end(); return; }
  if (req.url === "/_stats") {
    const sorted = [...recent].sort((a, b) => a - b);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ queue: queue.length, ...stats, totalMs: { n: sorted.length, avg: sorted.length ? Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length) : 0, p95: sorted[Math.floor(sorted.length * 0.95)] ?? 0 }, keys: keys.map(({ key, ...s }) => s) }));
    return;
  }
  if (req.method === "POST" && req.url === "/v1batch") { void handleBatch(req, res); return; }
  if (req.method !== "GET" || !req.url || !PATH_RE.test(req.url) || req.url.includes("..")) { res.writeHead(400).end(); return; }
  stats.received++;
  const tRecv = Date.now();
  res.on("finish", () => { recent.push(Date.now() - tRecv); if (recent.length > 2000) recent.shift(); });
  res.on("close", () => { if (!res.writableFinished) stats.aborted++; });
  if (queue.length >= MAX_QUEUE) { stats.rejectedFull++; fail({ res, path: req.url, enqueuedAt: Date.now() }, 503, "queue full", 2); return; }
  queue.push({ res, path: req.url, enqueuedAt: Date.now(), acceptEncoding: String(req.headers["accept-encoding"] ?? "gzip") });
  pump();
});
server.keepAliveTimeout = 120_000; server.headersTimeout = 125_000; // default 5s makes clients reuse sockets the server already closed
server.listen(PORT, HOST, () => console.log(`gateway on ${HOST}:${PORT} with ${keys.length} keys @ ${RPS} rps/key`));
