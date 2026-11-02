/** HTTP client to the VPS gateway. Raw gzip bytes in, parsed JSON out; failures are classified for the job runner. */
import http from "node:http";
import https from "node:https";
import zlib from "node:zlib";
import { cfg, sleep } from "./config.js";
import { sql } from "./db.js";
import { closeLocal, waitOpen } from "./gate.js";
import { saveRaw } from "./raw.js";

export class RetryLater extends Error { constructor(public delayMs: number, msg: string) { super(msg); } }
export class NotFound extends Error {}

export interface RawResult { status: number; body: Buffer; encoding?: string; retryAfter?: number; keyId?: string }

export function rawRequest(path: string, timeoutMs = 20_000): Promise<RawResult> {
  const url = new URL(path, cfg.gatewayUrl);
  const mod = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(url, { method: "GET", timeout: timeoutMs,
      headers: { "x-gateway-secret": cfg.gatewaySecret, "accept-encoding": "gzip" } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks), encoding: res.headers["content-encoding"] as string | undefined,
        retryAfter: res.headers["retry-after"] ? Number(res.headers["retry-after"]) : undefined, keyId: res.headers["x-key-id"] as string | undefined }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });
}
const decode = (r: RawResult) => (r.encoding === "gzip" ? zlib.gunzipSync(r.body) : r.body).toString("utf8");

// per-process pacing (each worker process has its own requests_per_second)
let interval = 0, nextSlot = 0;
export const setRps = (rps: number) => { interval = rps > 0 ? 1000 / rps : 0; };
async function pace() {
  if (!interval) return;
  const at = Math.max(Date.now(), nextSlot); nextSlot = at + interval;
  const wait = at - Date.now(); if (wait > 0) await sleep(wait);
}

// buffered fetch_log
const logBuf: any[] = [];
setInterval(async () => {
  if (!logBuf.length) return;
  const rows = logBuf.splice(0, logBuf.length);
  try {
    await sql`insert into fetch_log (endpoint, status, ms, bytes, key_id, season_id)
      select t.endpoint, t.status, t.ms, t.bytes, t.key_id, t.season_id
      from jsonb_to_recordset(${sql.json(rows)}::jsonb) as t(endpoint text, status smallint, ms int, bytes int, key_id smallint, season_id bigint)`;
  } catch { /* logging must never break ingestion */ }
}, 3000).unref();

const endpointOf = (p: string) => p.split("?")[0].replace(/%23[A-Z0-9]+/gi, ":tag").replace(/\/\d{6,}/g, "/:id");

export async function cocGet(path: string, meta: { kind: string; key: string; seasonId?: number }): Promise<any> {
  await waitOpen();
  await pace();
  const t0 = Date.now();
  let r: RawResult;
  try { r = await rawRequest(path); }
  catch { closeLocal(); throw new RetryLater(15_000, "gateway unreachable (proxy outage)"); }
  let text = ""; let json: any = null;
  try { text = decode(r); json = JSON.parse(text); } catch { /* non-JSON error page */ }
  logBuf.push({ endpoint: endpointOf(path), status: r.status, ms: Date.now() - t0, bytes: r.body.length, key_id: r.keyId ? Number(r.keyId) : null, season_id: meta.seasonId ?? null });

  if (r.status === 200 && json) { saveRaw(meta.kind, meta.key, text, meta.seasonId); return json; }
  if (r.status === 404) throw new NotFound(path);
  if (json?.reason === "inMaintenance" || /maintenance/i.test(String(json?.message ?? ""))) { closeLocal(); throw new RetryLater(60_000, "official maintenance"); }
  if (r.status === 429) throw new RetryLater((r.retryAfter ?? 2) * 1000, "429 throttled");
  if (json?.reason === "gateway") throw new RetryLater((r.retryAfter ?? 2) * 1000, `gateway: ${json.message}`);
  if (r.status === 403) throw new RetryLater(30_000, `403 (key/IP problem?) ${text.slice(0, 120)}`);
  if (r.status >= 500) throw new RetryLater(10_000, `upstream ${r.status}`);
  throw new Error(`HTTP ${r.status}: ${text.slice(0, 200)}`);
}

/** Single un-gated probe for the availability controller. */
export async function probe(): Promise<"ok" | "maintenance" | "proxy_down"> {
  try {
    const r = await rawRequest("/v1/locations?limit=1", 10_000);
    if (r.status === 200) return "ok";
    let j: any = null; try { j = JSON.parse(decode(r)); } catch {}
    if (j?.reason === "inMaintenance" || /maintenance/i.test(String(j?.message ?? ""))) return "maintenance";
    return "proxy_down";
  } catch { return "proxy_down"; }
}
