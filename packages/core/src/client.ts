/**
 * HTTP client to the VPS gateway. Raw gzip bytes in, parsed JSON out; failures are classified for the job runner.
 * Two modes: cocGet (one round trip per call) and cocPrefetch (up to 100 calls per round trip via /v1batch, results consumed later by cocGet).
 */
import http from "node:http";
import https from "node:https";
import zlib from "node:zlib";
import { cfg, sleep, envNum } from "./config.js";
import { sql } from "./db.js";
import { closeLocal, waitOpen } from "./gate.js";
import { saveRaw } from "./raw.js";
import { oldestServedSeasonId } from "@coc/shared";

export class RetryLater extends Error { constructor(public delayMs: number, msg: string) { super(msg); } }
export class NotFound extends Error {}

export interface RawResult { status: number; body: Buffer; encoding?: string; retryAfter?: number; keyId?: string; queueMs?: number; ttfbMs?: number }

const agents = { "http:": new http.Agent({ keepAlive: true, maxSockets: 512 }), "https:": new https.Agent({ keepAlive: true, maxSockets: 512 }) };

function requestOnce(method: "GET" | "POST", path: string, timeoutMs: number, body?: string): Promise<RawResult> {
  const url = new URL(path, cfg.gatewayUrl);
  const mod = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const headers: Record<string, string | number> = { "x-gateway-secret": cfg.gatewaySecret, "accept-encoding": "gzip" };
    if (body !== undefined) { headers["content-type"] = "application/json"; headers["content-length"] = Buffer.byteLength(body); }
    const req = mod.request(url, { method, timeout: timeoutMs, agent: agents[url.protocol === "https:" ? "https:" : "http:"], headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks), encoding: res.headers["content-encoding"] as string | undefined,
        retryAfter: res.headers["retry-after"] ? Number(res.headers["retry-after"]) : undefined, keyId: res.headers["x-key-id"] as string | undefined,
        queueMs: res.headers["x-queue-ms"] ? Number(res.headers["x-queue-ms"]) : undefined, ttfbMs: res.headers["x-ttfb-ms"] ? Number(res.headers["x-ttfb-ms"]) : undefined }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(Object.assign(new Error("timeout"), { code: "TIMEOUT" })));
    req.on("error", (err: any) => { err.reused = req.reusedSocket; reject(err); });
    if (body !== undefined) req.write(body);
    req.end();
  });
}
async function withStaleRetry(f: () => Promise<RawResult>): Promise<RawResult> {
  try { return await f(); }
  catch (e: any) { if (e?.code === "ECONNRESET" && e?.reused) return f(); throw e; } // stale keep-alive socket: one transparent retry
}
export const rawRequest = (path: string, timeoutMs = 20_000) => withStaleRetry(() => requestOnce("GET", path, timeoutMs));
export const rawPost = (path: string, payload: unknown, timeoutMs = 60_000) => withStaleRetry(() => requestOnce("POST", path, timeoutMs, JSON.stringify(payload)));
const decode = (r: { body: Buffer; encoding?: string }) => (r.encoding === "gzip" ? zlib.gunzipSync(r.body) : r.body).toString("utf8");

/**
 * Adaptive in-flight limit (AIMD): grows by 1 per 10 healthy responses, x0.8 on any error or slow response.
 * Measures only the network round trip (never the wait for a permit).
 */
class Limiter {
  inflight = 0; private okStreak = 0; private waiters: (() => void)[] = [];
  constructor(public limit: number, private min: number, private max: number) {}
  async acquire() { if (this.inflight < Math.floor(this.limit)) { this.inflight++; return; } await new Promise<void>((r) => this.waiters.push(r)); }
  release(good: boolean) {
    this.inflight--;
    if (good) { if (++this.okStreak >= 10) { this.limit = Math.min(this.max, this.limit + 1); this.okStreak = 0; } }
    else { this.limit = Math.max(this.min, this.limit * 0.8); this.okStreak = 0; }
    while (this.waiters.length && this.inflight < Math.floor(this.limit)) { this.inflight++; this.waiters.shift()!(); }
  }
}
const MAX_INFLIGHT = envNum("CLIENT_MAX_INFLIGHT", 48);
const SLOW_MS = envNum("CLIENT_SLOW_MS", 4000); // a single round trip slower than this counts as congestion
const limiter = new Limiter(Math.min(12, MAX_INFLIGHT), 2, MAX_INFLIGHT);
export const limiterState = () => ({ limit: Math.floor(limiter.limit), inflight: limiter.inflight });

// per-process pacing (each worker process has its own requests_per_second); a batch of n calls takes n slots
let interval = 0, nextSlot = 0;
export const setRps = (rps: number) => { interval = rps > 0 ? 1000 / rps : 0; };
async function pace(n = 1) {
  if (!interval) return;
  const at = Math.max(Date.now(), nextSlot); nextSlot = at + interval * n;
  const wait = at - Date.now(); if (wait > 0) await sleep(wait);
}

let consecFail = 0;
// buffered fetch_log
const logBuf: any[] = [];
setInterval(async () => {
  if (!logBuf.length) return;
  const rows = logBuf.splice(0, logBuf.length);
  try {
    await sql`insert into fetch_log (endpoint, status, ms, bytes, key_id, season_id, queue_ms, ttfb_ms, err)
      select t.endpoint, t.status, t.ms, t.bytes, t.key_id, t.season_id, t.queue_ms, t.ttfb_ms, t.err
      from jsonb_to_recordset(${sql.json(rows)}::jsonb) as t(endpoint text, status smallint, ms int, bytes int, key_id smallint, season_id bigint, queue_ms int, ttfb_ms int, err text)`;
  } catch { /* logging must never break ingestion */ }
}, 3000).unref();

const endpointOf = (p: string) => p.split("?")[0].replace(/%23[A-Z0-9]+/gi, ":tag").replace(/\/\d{6,}/g, "/:id");

interface Resp { status: number; text: string; json: any; retryAfter?: number; netErr?: string }

function noteNetFail(e: any, path: string, ms: number, seasonId?: number) {
  const code: string = e?.code ?? "ERR";
  logBuf.push({ endpoint: endpointOf(path), status: 0, ms, bytes: 0, key_id: null, season_id: seasonId ?? null, queue_ms: null, ttfb_ms: null, err: code });
  consecFail++;
  const hard = ["ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH", "ENETUNREACH"].includes(code);
  if (hard || consecFail >= 8) closeLocal(); // a lone timeout/reset only retries this job; a real outage closes the gate
  return { code, delayMs: hard ? 15_000 : 3_000 };
}

/** Turn a response into JSON or a typed error. Saves the raw layer on success. */
function interpret(r: Resp, path: string, meta: { kind: string; key: string; seasonId?: number }): any {
  if (r.netErr) throw new RetryLater(3_000, `gateway request failed (${r.netErr})`);
  if (r.status === 200 && r.json) { saveRaw(meta.kind, meta.key, r.text, meta.seasonId); return r.json; }
  const json = r.json;
  if (r.status === 404) throw new NotFound(path);
  if (json?.reason === "inMaintenance" || /maintenance/i.test(String(json?.message ?? ""))) { closeLocal(); throw new RetryLater(60_000, "official maintenance"); }
  if (r.status === 429) throw new RetryLater((r.retryAfter ?? 2) * 1000, "429 throttled");
  if (json?.reason === "gateway") throw new RetryLater((r.retryAfter ?? 2) * 1000, `gateway: ${json.message}`);
  if (r.status === 403) throw new RetryLater(30_000, `403 (key/IP problem?) ${r.text.slice(0, 120)}`);
  if (r.status >= 500) {
    // the API answers 500 (not 404) for group lookups of seasons that fell out of its window: that is permanent, don't retry
    if (meta.kind === "group" && meta.seasonId != null && meta.seasonId < oldestServedSeasonId()) throw new NotFound(`season ${meta.seasonId} outside API window`);
    throw new RetryLater(10_000, `upstream ${r.status}`);
  }
  throw new Error(`HTTP ${r.status}: ${r.text.slice(0, 200)}`);
}
const parse = (text: string) => { try { return JSON.parse(text); } catch { return null; } };

// ---------------- prefetch (batched) ----------------
export interface PrefetchReq { path: string; kind: string; key: string; seasonId?: number }
const cache = new Map<string, { resp: Resp; at: number }>();
let batchSupported = true;

export async function cocPrefetch(reqs: PrefetchReq[]) {
  if (!batchSupported || reqs.length === 0) return;
  for (const [p, e] of cache) if (Date.now() - e.at > 300_000) cache.delete(p);
  await waitOpen();
  const chunks: PrefetchReq[][] = []; for (let i = 0; i < reqs.length; i += 100) chunks.push(reqs.slice(i, i + 100));
  await Promise.all(chunks.map(async (chunk) => {
    await pace(chunk.length); await limiter.acquire();
    const t0 = Date.now(); let out: RawResult;
    try { out = await rawPost("/v1batch", { paths: chunk.map((c) => c.path) }); consecFail = 0; limiter.release(Date.now() - t0 < SLOW_MS + 60 * chunk.length); }
    catch (e: any) {
      limiter.release(false);
      const f = noteNetFail(e, "/v1batch", Date.now() - t0);
      for (const c of chunk) cache.set(c.path, { at: Date.now(), resp: { status: -1, text: "", json: null, netErr: f.code } });
      return;
    }
    if (out.status === 400 || out.status === 404) { batchSupported = false; console.warn("[client] gateway has no /v1batch (old version?): falling back to single requests"); return; }
    if (out.status !== 200) { for (const c of chunk) cache.set(c.path, { at: Date.now(), resp: { status: 503, text: "", json: { reason: "gateway", message: `batch HTTP ${out.status}` }, retryAfter: out.retryAfter ?? 2 } }); return; }
    const payload = parse(decode(out));
    if (!payload?.results || payload.results.length !== chunk.length) { batchSupported = false; return; }
    payload.results.forEach((it: any, i: number) => {
      const buf = Buffer.from(it.body, "base64");
      const text = (it.enc === "gzip" ? zlib.gunzipSync(buf) : buf).toString("utf8");
      cache.set(chunk[i].path, { at: Date.now(), resp: { status: it.status, text, json: parse(text), retryAfter: it.retryAfter } });
      logBuf.push({ endpoint: endpointOf(chunk[i].path), status: it.status, ms: Date.now() - t0, bytes: buf.length, key_id: it.key >= 0 ? it.key : null, season_id: chunk[i].seasonId ?? null, queue_ms: it.queueMs ?? null, ttfb_ms: it.ttfbMs ?? null, err: null });
    });
  }));
}

// ---------------- single request ----------------
export async function cocGet(path: string, meta: { kind: string; key: string; seasonId?: number }): Promise<any> {
  const hit = cache.get(path);
  if (hit) { cache.delete(path); return interpret(hit.resp, path, meta); }
  await waitOpen();
  await pace(1);
  await limiter.acquire();
  const t0 = Date.now(); // measure the network round trip only, never the wait for a permit
  let r: RawResult;
  try { r = await rawRequest(path); consecFail = 0; limiter.release(Date.now() - t0 < SLOW_MS); }
  catch (e: any) {
    limiter.release(false);
    const f = noteNetFail(e, path, Date.now() - t0, meta.seasonId);
    throw new RetryLater(f.delayMs, `gateway request failed (${f.code})`);
  }
  const text = decode(r);
  logBuf.push({ endpoint: endpointOf(path), status: r.status, ms: Date.now() - t0, bytes: r.body.length, key_id: r.keyId ? Number(r.keyId) : null, season_id: meta.seasonId ?? null, queue_ms: r.queueMs ?? null, ttfb_ms: r.ttfbMs ?? null, err: null });
  return interpret({ status: r.status, text, json: parse(text), retryAfter: r.retryAfter }, path, meta);
}

/** Single un-gated probe for the availability controller. */
export async function probe(): Promise<"ok" | "maintenance" | "proxy_down"> {
  try {
    const r = await rawRequest("/v1/locations?limit=1", 15_000);
    if (r.status === 200) return "ok";
    const j = parse(decode(r));
    if (j?.reason === "inMaintenance" || /maintenance/i.test(String(j?.message ?? ""))) return "maintenance";
    return "proxy_down";
  } catch { return "proxy_down"; }
}
