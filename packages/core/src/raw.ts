/** Raw layer: every successful response, as NDJSON in per-process hourly gzip segments (gzip members concatenate). */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { cfg } from "./config.js";

let stream: fs.WriteStream | null = null;
let segment = "";
const proc = process.env.PROC_NAME ?? `p${process.pid}`;

export function saveRaw(kind: string, key: string, bodyText: string, seasonId?: number) {
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const seg = `${day}/${proc}-${now.toISOString().slice(11, 13)}.ndjson.gz`;
  if (seg !== segment) {
    stream?.end();
    const file = path.join(cfg.rawDir, seg);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    stream = fs.createWriteStream(file, { flags: "a" });
    segment = seg;
  }
  const line = `{"t":${now.getTime()},"kind":${JSON.stringify(kind)},"key":${JSON.stringify(key)},"season":${seasonId ?? "null"},"d":${bodyText}}\n`;
  stream!.write(zlib.gzipSync(line, { level: 4 }));
}

export function pruneRaw(days = cfg.rawRetentionDays): number {
  if (!fs.existsSync(cfg.rawDir)) return 0;
  const cutoff = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
  let n = 0;
  for (const d of fs.readdirSync(cfg.rawDir)) if (/^\d{4}-\d\d-\d\d$/.test(d) && d < cutoff) { fs.rmSync(path.join(cfg.rawDir, d), { recursive: true }); n++; }
  return n;
}
