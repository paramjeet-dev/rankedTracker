/**
 * API gateway for the VPS (static IP). Holds all keys, enforces per-key rate limits,
 * forwards GET /v1/* to api.clashofclans.com and streams the response through untouched
 * (gzip stays gzip: no decompression, keeps CPU and egress low on a 1 vCPU / 100 Mbps box).
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
const UPSTREAM = "api.clashofclans.com";
if (!SECRET || KEYS.length === 0) throw new Error("GATEWAY_SECRET and COC_KEYS are required");

interface KeyState { id: number; key: string; nextAt: number; cooldownUntil: number; disabled: boolean; ok: number; throttled: number; errors: number }
const keys: KeyState[] = KEYS.map((key, id) => ({ id, key, nextAt: 0, cooldownUntil: 0, disabled: false, ok: 0, throttled: 0, errors: 0 }));
const interval = 1000 / RPS;

interface Job { req: http.IncomingMessage; res: http.ServerResponse; path: string; enqueuedAt: number }
const queue: Job[] = [];
let timer: NodeJS.Timeout | null = null;
const stats = { received: 0, rejectedFull: 0, upstream429: 0, aborted: 0, started: Date.now() };
const recent: number[] = []; // total ms per finished response (receive -> last byte handed to the socket)

const authed = (req: http.IncomingMessage) => {
  const given = Buffer.from(String(req.headers["x-gateway-secret"] ?? ""));
  const want = Buffer.from(SECRET);
  return given.length === want.length && timingSafeEqual(given, want);
};

function pump() {
  if (timer) { clearTimeout(timer); timer = null; }
  const now = Date.now();
  while (queue.length) {
    const live = keys.filter((k) => !k.disabled);
    if (live.length === 0) { while (queue.length) fail(queue.shift()!, 503, "no usable keys"); return; }
    const k = live.reduce((a, b) => (Math.max(a.nextAt, a.cooldownUntil) <= Math.max(b.nextAt, b.cooldownUntil) ? a : b));
    const ready = Math.max(k.nextAt, k.cooldownUntil);
    if (ready > Date.now()) { timer = setTimeout(pump, ready - Date.now()); return; }
    const job = queue.shift()!;
    if (job.res.destroyed || job.res.writableEnded) continue; // client gave up while queued
    k.nextAt = Math.max(Date.now(), k.nextAt) + interval;
    dispatch(job, k);
  }
  void now;
}

function fail(job: Job, status: number, msg: string, retryAfter?: number) {
  if (job.res.headersSent) return;
  job.res.writeHead(status, { "content-type": "application/json", ...(retryAfter ? { "retry-after": String(retryAfter) } : {}) });
  job.res.end(JSON.stringify({ reason: "gateway", message: msg }));
}

function dispatch(job: Job, k: KeyState) {
  const queuedMs = Date.now() - job.enqueuedAt, t0 = Date.now();
  const up = https.request(
    { host: UPSTREAM, path: job.path, method: "GET", timeout: 15000,
      headers: { authorization: `Bearer ${k.key}`, accept: "application/json", "accept-encoding": String(job.req.headers["accept-encoding"] ?? "gzip") } },
    (r) => {
      const status = r.statusCode ?? 502;
      if (status === 429) { k.throttled++; stats.upstream429++; k.cooldownUntil = Date.now() + 2000; }
      else if (status === 403 && !job.path.includes("/leaguegroup")) { k.errors++; } // 403 may be a bad key/IP; see /_stats
      else if (status < 500) k.ok++;
      const h: http.OutgoingHttpHeaders = { "x-key-id": String(k.id), "x-queue-ms": String(queuedMs), "x-ttfb-ms": String(Date.now() - t0) };
      for (const n of ["content-type", "content-encoding", "cache-control", "retry-after"]) if (r.headers[n]) h[n] = r.headers[n];
      job.res.writeHead(status, h);
      r.pipe(job.res);
    },
  );
  up.on("timeout", () => up.destroy(new Error("upstream timeout")));
  up.on("error", () => { k.errors++; fail(job, 502, "upstream error", 1); });
  up.end();
}

const server = http.createServer((req, res) => {
  if (!authed(req)) { res.writeHead(401).end(); return; }
  if (req.url === "/_stats") {
    res.writeHead(200, { "content-type": "application/json" });
    const sorted = [...recent].sort((a, b) => a - b);
    res.end(JSON.stringify({ queue: queue.length, ...stats, totalMs: { n: sorted.length, avg: sorted.length ? Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length) : 0, p95: sorted[Math.floor(sorted.length * 0.95)] ?? 0 }, keys: keys.map(({ key, ...s }) => s) }));
    return;
  }
  if (req.method !== "GET" || !req.url || !/^\/v1\/[A-Za-z0-9%/_.\-?=&]*$/.test(req.url) || req.url.includes("..")) {
    res.writeHead(400).end(); return;
  }
  stats.received++;
  const tRecv = Date.now();
  res.on("finish", () => { recent.push(Date.now() - tRecv); if (recent.length > 2000) recent.shift(); });
  res.on("close", () => { if (!res.writableFinished) stats.aborted++; });
  if (queue.length >= MAX_QUEUE) { stats.rejectedFull++; fail({ req, res, path: req.url, enqueuedAt: Date.now() }, 503, "queue full", 2); return; }
  queue.push({ req, res, path: req.url, enqueuedAt: Date.now() });
  pump();
});
server.keepAliveTimeout = 120_000; server.headersTimeout = 125_000; // default 5s makes clients reuse sockets the server already closed
server.listen(PORT, HOST, () => console.log(`gateway on ${HOST}:${PORT} with ${keys.length} keys @ ${RPS} rps/key`));
