/**
 * Pre-flight smoke test. Needs only the gateway (no Postgres). Calls each endpoint once, runs the real parsers,
 * prints what matched, and saves raw payloads to data/smoke/.   Run: npm run smoke
 * Optional: SMOKE_TAG=#YOURTAG npm run smoke   (a player currently in Titan..Electro, e.g. you or a clanmate)
 */
import fs from "node:fs";
import zlib from "node:zlib";
import { rawRequest, parseProfile, parseHistory, parseGroup, playerPath, historyPath, GROUP_STYLES, rankingsPath, locationsPath } from "@coc/core";
import { attackerTrophies, defenderTrophies, inScope, normalizeTag } from "@coc/shared";

fs.mkdirSync("data/smoke", { recursive: true });
let failures = 0;
const ok = (m: string) => console.log("  \u2713", m);
const bad = (m: string) => { failures++; console.log("  \u2717", m); };
const dec = (r: { body: Buffer; encoding?: string }) => (r.encoding === "gzip" ? zlib.gunzipSync(r.body) : r.body).toString("utf8");
const keysOf = (o: any) => Object.keys(o ?? {}).join(", ");

async function get(name: string, path: string, quiet = false) {
  let r;
  try { r = await rawRequest(path); } catch (e: any) { bad(`${name}: cannot reach gateway (${e.code ?? e.message}). Tunnel up? GATEWAY_URL right?`); return null; }
  const text = dec(r);
  if (!quiet) fs.writeFileSync(`data/smoke/${name}.json`, text);
  if (r.status === 200) { if (!quiet) ok(`${name}: 200 via key #${r.keyId ?? "?"} (${r.body.length} bytes on the wire)`); return JSON.parse(text); }
  const hint: Record<number, string> = { 401: "GATEWAY_SECRET mismatch", 403: "key not allow-listed for the VPS IP, or wrong key", 404: "not found", 429: "throttled", 503: "gateway queue full or maintenance" };
  if (!quiet) bad(`${name}: HTTP ${r.status} ${hint[r.status] ?? ""} ${text.slice(0, 160)}`);
  return null;
}

console.log("1) gateway + keys");
const stats = await get("gateway_stats", "/_stats");
if (stats) console.log("   keys:", stats.keys.map((k: any) => `#${k.id}${k.disabled ? " DISABLED" : ""}`).join(" "));
await get("locations_probe", "/v1/locations?limit=1");

console.log("2) leaderboards: which ranked tiers do the top players sit in? (we only want 105000026..105000033)");
const locs = await get("locations", locationsPath(), true);
const ids: (string | number)[] = ["global", ...(locs?.items ?? []).filter((l: any) => l.isCountry).slice(0, 25).map((l: any) => l.id)];
const tierCount: Record<string, number> = {}; const candidates: { tag: string; tier: number }[] = [];
for (const id of ids) {
  const j = await get(`rank_${id}`, rankingsPath(id), true);
  if (id === "global" && j) { fs.writeFileSync("data/smoke/rankings_global.json", JSON.stringify(j)); console.log("   item keys:", keysOf(j.items?.[0])); }
  for (const i of j?.items ?? []) {
    const t = i.leagueTier?.id; tierCount[String(t)] = (tierCount[String(t)] ?? 0) + 1;
    if (t != null && inScope(Number(t))) candidates.push({ tag: normalizeTag(i.tag), tier: Number(t) });
  }
  if (candidates.length >= 3) break;
}
console.log("   tiers seen on leaderboards:", JSON.stringify(tierCount));
const given = process.env.SMOKE_TAG ? [{ tag: normalizeTag(process.env.SMOKE_TAG), tier: -1 }] : [];
const subjects = [...given, ...candidates].filter((c, i, a) => a.findIndex((x) => x.tag === c.tag) === i).slice(0, 3);
if (subjects.length) ok(`test subjects: ${subjects.map((s) => `${s.tag} (tier ${s.tier})`).join(", ")}`);
else bad("no in-scope player found on the leaderboards. Re-run with SMOKE_TAG=#SOMEONE_IN_TITAN_TO_ELECTRO (yourself or a clanmate)");

console.log("3) profile -> league group refs");
let found: { p: ReturnType<typeof parseProfile> } | null = null;
for (const s of subjects) {
  const j = await get(`profile_${s.tag.replace("#", "")}`, playerPath(s.tag));
  if (!j) continue;
  try {
    const p = parseProfile(j);
    console.log(`   ${p.tag}: tier=${p.tierId} (${p.tierId !== null && inScope(p.tierId) ? "in scope" : "OUT of scope"}) current=${JSON.stringify(p.current)} previous=${JSON.stringify(p.previous)}`);
    if (p.tierId !== null && inScope(p.tierId) && (p.current || p.previous)) { found = { p }; break; }
  } catch (e: any) { bad(`parseProfile: ${e.message}`); }
}
if (!found) bad("no in-scope player with group refs; cannot test the group endpoint");

if (found) {
  const { p } = found;
  console.log("4) league history (season ids vs the profile's refs)");
  const h = await get("history", historyPath(p.tag));
  if (h) try {
    const rows = parseHistory(h);
    for (const r of rows.slice(-4)) console.log(`   season ${r.seasonId} = ${new Date(r.seasonId * 1000).toISOString()}  tier ${r.tierId}  trophies ${r.trophies}  placement ${r.placement}  battles ${r.attackWins + r.attackLosses}/${r.maxBattles}`);
    ok(`parsed ${rows.length} seasons`);
  } catch (e: any) { bad(`parseHistory: ${e.message}`); }

  console.log("5) league group: trying every way of passing the player tag");
  let winner = "";
  for (const [label, ref] of [["previous", p.previous], ["current", p.current]] as const) {
    if (!ref) { console.log(`   (no ${label} ref)`); continue; }
    for (const [style, build] of Object.entries(GROUP_STYLES)) {
      let r; try { r = await rawRequest(build(ref.groupTag, ref.seasonId, p.tag)); } catch { bad("gateway unreachable"); continue; }
      const text = dec(r);
      console.log(`   ${label.padEnd(8)} style=${style.padEnd(9)} -> HTTP ${r.status} ${r.status === 200 ? "" : text.slice(0, 110)}`);
      if (r.status === 200 && !winner) {
        winner = style; fs.writeFileSync(`data/smoke/group_${label}.json`, text);
        const g = JSON.parse(text); console.log("   top-level keys:", keysOf(g));
        try {
          const parsed = parseGroup(g, p.tag);
          ok(`${label}: ${parsed.members.length} members, ${parsed.battles.length} battles from the probe's logs`);
          const a = parsed.battles.filter((b) => b.atkRep !== null), d = parsed.battles.filter((b) => b.defRep !== null);
          if (a.length) console.log(`   attack-log trophies == attackerTrophies(): ${a.filter((b) => b.atkRep === attackerTrophies(b.stars, b.destruction)).length}/${a.length}`);
          if (d.length) console.log(`   defense-log trophies == defenderTrophies(): ${d.filter((b) => b.defRep === defenderTrophies(b.stars, b.destruction)).length}/${d.length}  (== attackerTrophies(): ${d.filter((b) => b.defRep === attackerTrophies(b.stars, b.destruction)).length}/${d.length})`);
        } catch (e: any) { bad(`parseGroup (${label}): ${e.message}`); }
      }
    }
  }
  winner ? ok(`group endpoint answers with style "${winner}"  ->  put GROUP_STYLE=${winner} in .env`) : bad("no URL style returned 200 for the group endpoint");
}
console.log(failures ? `\n${failures} problem(s). Raw payloads are in data/smoke/ .` : "\nAll smoke checks passed. Safe to start workers.");
process.exit(failures ? 1 : 0);
