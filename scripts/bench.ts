/**
 * Transport benchmark: how much can the path PC -> (tunnel) -> gateway really carry, independent of the job queue?
 * STOP ALL WORKERS FIRST (they would compete for the same link).   npm run bench
 *  ping      = /_stats: tunnel + gateway only, no official API
 *  locations = tiny official API call
 *  group     = real league-group payloads (size shows whether bandwidth is the limit)
 */
import { rawRequest, rawPost, sql } from "@coc/core";
import { currentSeasonId } from "@coc/shared";
import { groupPath } from "@coc/core";

const pct = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))] ?? 0; };
async function sweep(name: string, paths: string[], levels = [1, 4, 8, 16, 32, 64], seconds = 8) {
  console.log(`\n== ${name} (${seconds}s per level)`);
  const rows: any[] = [];
  for (const c of levels) {
    const ms: number[] = []; let ok = 0, err = 0, bytes = 0; const errs: Record<string, number> = {}; const end = Date.now() + seconds * 1000; let i = 0;
    await Promise.all(Array.from({ length: c }, async () => {
      while (Date.now() < end) {
        const t0 = Date.now();
        try { const r = await rawRequest(paths[i++ % paths.length], 30_000); if (r.status === 200) { ok++; bytes += r.body.length; ms.push(Date.now() - t0); } else { err++; errs["HTTP" + r.status] = (errs["HTTP" + r.status] ?? 0) + 1; } }
        catch (e: any) { err++; errs[e?.code ?? "ERR"] = (errs[e?.code ?? "ERR"] ?? 0) + 1; }
      }
    }));
    rows.push({ concurrency: c, ok_per_s: +(ok / seconds).toFixed(1), p50_ms: pct(ms, 0.5), p95_ms: pct(ms, 0.95), MB_per_s: +(bytes / seconds / 1e6).toFixed(2), errors: err, ...(err ? { causes: JSON.stringify(errs) } : {}) });
    if (err > ok * 0.3 && c >= 8) { console.log(`  (stopping sweep: ${err} errors at concurrency ${c})`); break; }
  }
  console.table(rows);
}
async function sweepBatch(name: string, paths: string[], size = 50, levels = [1, 2, 4, 8], seconds = 10) {
  console.log(`\n== ${name}: ${size} calls per round trip (${seconds}s per level)`);
  const rows: any[] = [];
  for (const c of levels) {
    const ms: number[] = []; let calls = 0, err = 0, bytes = 0; const end = Date.now() + seconds * 1000; let i = 0;
    await Promise.all(Array.from({ length: c }, async () => {
      while (Date.now() < end) {
        const t0 = Date.now(); const batch = Array.from({ length: size }, () => paths[i++ % paths.length]);
        try { const r = await rawPost("/v1batch", { paths: batch }, 90_000); if (r.status === 200) { calls += size; bytes += r.body.length; ms.push(Date.now() - t0); } else err++; } catch { err++; }
      }
    }));
    rows.push({ parallel_batches: c, api_calls_per_s: +(calls / seconds).toFixed(1), batch_p50_ms: pct(ms, 0.5), batch_p95_ms: pct(ms, 0.95), MB_per_s: +(bytes / seconds / 1e6).toFixed(2), errors: err });
  }
  console.table(rows);
}
await sweep("ping (tunnel + gateway only)", ["/_stats"]);
await sweep("locations (tiny official API call)", ["/v1/locations?limit=1"]);
const prev = currentSeasonId() - 604800;
const g = await sql<{ group_tag: string; probe_player_tag: string }[]>`select group_tag, probe_player_tag from league_group where season_id = ${prev} and roster_fetched_at is not null order by random() limit 40`;
if (g.length) {
  const gp = g.map((x) => groupPath(x.group_tag, prev, x.probe_player_tag));
  await sweep("group payloads, one call per round trip", gp, [1, 4, 8, 16, 32]);
  await sweepBatch("group payloads batched", gp, 50);
}
await sql.end();
