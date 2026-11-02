/**
 * Pre-flight smoke test. Needs only the gateway (no Postgres). Calls each endpoint once, runs the real parsers,
 * prints what matched, and saves raw payloads to data/smoke/ so mismatches can be inspected or shared.
 * Run: npm run smoke
 */
import fs from "node:fs";
import zlib from "node:zlib";
import { rawRequest, parseProfile, parseHistory, parseGroup, playerPath, historyPath, groupPath, rankingsPath, currentSeasonId } from "@coc/core";
import { SEASON_LEN, attackerTrophies, defenderTrophies } from "@coc/shared";

fs.mkdirSync("data/smoke", { recursive: true });
let failures = 0;
const ok = (m: string) => console.log("  \u2713", m);
const bad = (m: string) => { failures++; console.log("  \u2717", m); };
const dec = (r: { body: Buffer; encoding?: string }) => (r.encoding === "gzip" ? zlib.gunzipSync(r.body) : r.body).toString("utf8");
const dump = (name: string, text: string) => fs.writeFileSync(`data/smoke/${name}.json`, text);

async function get(name: string, path: string) {
  let r;
  try { r = await rawRequest(path); } catch (e: any) { bad(`${name}: cannot reach gateway (${e.code ?? e.message}). Tunnel up? GATEWAY_URL right?`); return null; }
  const text = dec(r); dump(name, text);
  if (r.status === 200) { ok(`${name}: 200 via key #${r.keyId ?? "?"} (${r.body.length} bytes on the wire)`); return JSON.parse(text); }
  const hint: Record<number, string> = { 401: "GATEWAY_SECRET mismatch", 403: "key not allow-listed for the VPS IP (invalidIp) or wrong key", 404: "not found", 429: "throttled", 503: "gateway queue full or maintenance" };
  bad(`${name}: HTTP ${r.status} ${hint[r.status] ?? ""} ${text.slice(0, 160)}`); return null;
}
const keysOf = (o: any) => Object.keys(o ?? {}).join(", ");

console.log("1) gateway + keys");
const stats = await get("gateway_stats", "/_stats");
if (stats) { console.log("   keys:", stats.keys.map((k: any) => `#${k.id}${k.disabled ? " DISABLED" : ""}`).join(" ")); }
await get("locations_probe", "/v1/locations?limit=1");

console.log("2) leaderboard");
const rank = await get("rankings_global", rankingsPath("global").replace("limit=200", "limit=15"));
if (rank) console.log("   item keys:", keysOf(rank.items?.[0]));

console.log("3) profile + league refs (tries leaderboard players until one has ranked-mode refs)");
let profile: ReturnType<typeof parseProfile> | null = null; let rawProfile: any = null;
for (const it of (rank?.items ?? []).slice(0, 10)) {
  const j = await get(`profile_${String(it.tag).replace("#", "")}`, playerPath(it.tag));
  if (!j) continue;
  try { const p = parseProfile(j); if (p.current || p.previous) { profile = p; rawProfile = j; break; } } catch (e: any) { bad(`parseProfile: ${e.message}`); }
}
if (profile) {
  ok(`parsed ${profile.tag}; tier=${profile.tierId}; current=${JSON.stringify(profile.current)} previous=${JSON.stringify(profile.previous)}`);
  const seasonCheck = [profile.current, profile.previous].filter(Boolean).every((r) => Number(r!.seasonId) % SEASON_LEN === currentSeasonId() % SEASON_LEN);
  seasonCheck ? ok("season ids are aligned to the Monday 05:00 UTC grid") : bad("season id is NOT on the assumed weekly grid (see shared/season.ts)");
} else {
  bad("no leaderboard player yielded league group refs. Fields on the profile that mention league/season/group:");
  const walk = (o: any, p = ""): string[] => Object.entries(o ?? {}).flatMap(([k, v]) => /league|season|group/i.test(k) ? [`${p}${k}`] : typeof v === "object" && v && !Array.isArray(v) ? walk(v, `${p}${k}.`) : []);
  console.log("   ", walk(rawProfile).join(", ") || "(none found; open data/smoke/profile_*.json)");
}

console.log("4) league history");
if (profile) {
  const h = await get("history", historyPath(profile.tag));
  if (h) try { const rows = parseHistory(h); ok(`parsed ${rows.length} seasons; last = ${JSON.stringify(rows.at(-1))}`); } catch (e: any) { bad(`parseHistory: ${e.message}`); }
}

console.log("5) league group (previous season first: complete data)");
if (profile) {
  for (const [label, ref] of [["previous", profile.previous], ["current", profile.current]] as const) {
    if (!ref) { console.log(`   (no ${label} ref)`); continue; }
    const g = await get(`group_${label}`, groupPath(ref.groupTag, ref.seasonId, profile.tag));
    if (!g) continue;
    console.log("   top-level keys:", keysOf(g));
    try {
      const parsed = parseGroup(g, profile.tag);
      ok(`${label}: ${parsed.members.length} members, ${parsed.battles.length} battles from the probe's logs`);
      const withRep = parsed.battles.filter((b) => b.atkRep !== null || b.defRep !== null);
      const a = parsed.battles.filter((b) => b.atkRep !== null), d = parsed.battles.filter((b) => b.defRep !== null);
      if (a.length) console.log(`   attack-log trophies == attackerTrophies(): ${a.filter((b) => b.atkRep === attackerTrophies(b.stars, b.destruction)).length}/${a.length}`);
      if (d.length) console.log(`   defense-log trophies == defenderTrophies(): ${d.filter((b) => b.defRep === defenderTrophies(b.stars, b.destruction)).length}/${d.length}  (== attackerTrophies(): ${d.filter((b) => b.defRep === attackerTrophies(b.stars, b.destruction)).length}/${d.length})`);
      void withRep;
    } catch (e: any) { bad(`parseGroup (${label}): ${e.message}`); }
  }
}
console.log(failures ? `\n${failures} problem(s). Raw payloads are in data/smoke/ .` : "\nAll smoke checks passed. Safe to start workers.");
process.exit(failures ? 1 : 0);
