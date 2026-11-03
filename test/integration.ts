import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import fs from "node:fs";
import assert from "node:assert/strict";

const db = new PGlite();
for (const f of ["001_init.sql", "002_workers.sql", "003_analytics.sql", "004_diagnostics.sql"]) await db.exec(fs.readFileSync(`packages/db/migrations/${f}`, "utf8"));
const server = new PGLiteSocketServer({ db, port: 54329, host: "127.0.0.1" });
await server.start();
process.env.DATABASE_URL = "postgres://postgres:postgres@127.0.0.1:54329/postgres";
const core = await import("@coc/core");
const { sql } = core;

// a group response shaped like the user's samples (top-level key names are the guesses under test)
const SEASON = 1791781200; // ended long ago -> season "final"
const payload = {
  members: [
    { playerTag: "#AAA", playerName: "Alice", clanTag: "#C1", clanName: "c1", leagueTrophies: 500, attackWinCount: 2, attackLoseCount: 0, defenseWinCount: 1, defenseLoseCount: 1 },
    { playerTag: "#BBB", playerName: "Bob", clanTag: "#C2", clanName: "c2", leagueTrophies: 300, attackWinCount: 1, attackLoseCount: 1, defenseWinCount: 0, defenseLoseCount: 2 },
    { playerTag: "#CCC", playerName: "Cy", clanTag: null, clanName: null, leagueTrophies: 100, attackWinCount: 0, attackLoseCount: 1, defenseWinCount: 1, defenseLoseCount: 0 },
  ],
  attackLog: [{ opponentPlayerTag: "#BBB", stars: 3, destructionPercentage: 100, trophies: 40, creationTime: "2026-10-12T06:00:00Z" },
              { opponentPlayerTag: "#CCC", stars: 2, destructionPercentage: 73, trophies: 23, creationTime: "2026-10-12T07:00:00Z" }],
  defenseLog: [{ opponentPlayerTag: "#CCC", stars: 0, destructionPercentage: 30, trophies: 40, creationTime: "2026-10-12T08:00:00Z" }],
};
const g = core.parseGroup(payload, "#AAA");
assert.equal(g.battles.length, 3);
await core.saveGroup(g, SEASON, "#GRP1", "#AAA");
// same battle seen from the other side (Bob's log): attacker #AAA hit #BBB, from the defense log
const bobView = core.parseGroup({ ...payload, attackLog: [], defenseLog: [{ opponentPlayerTag: "#AAA", stars: 3, destructionPercentage: 100, trophies: 0, creationTime: "2026-10-12T06:00:00Z" }] }, "#BBB");
await sql`update group_member set trophies = 999 where player_tag = '#CCC' and group_tag = '#GRP1'`; // sentinel: a roster:false save must not overwrite it
await core.saveGroup(bobView, SEASON, "#GRP1", "#BBB", { roster: false });
const [sent] = await sql`select trophies from group_member where player_tag = '#CCC'`; assert.equal(sent.trophies, 999, "memberlog mode leaves roster rows alone");
const [bobRow] = await sql`select log_final from group_member where player_tag = '#BBB'`; assert.equal(bobRow.log_final, true);
await sql`update group_member set trophies = 100 where player_tag = '#CCC' and group_tag = '#GRP1'`;

const battles = await sql`select attacker_tag, defender_tag, attacker_gain, defender_gain, atk_log_reported, def_log_reported from battle order by battle_time`;
console.table(battles);
assert.equal(battles.length, 3, "battle seen from both logs is stored once");
assert.equal(battles[0].atk_log_reported, 40); assert.equal(battles[0].def_log_reported, 0); // both sides' reported values merged
assert.equal(battles[1].attacker_gain, 23); assert.equal(battles[1].defender_gain, 17);
assert.equal(battles[2].defender_gain, 40); // CCC attacked Alice with 0 stars -> defender (Alice) gets 40

// queue: dedupe, claim, retry, complete
await core.enqueue({ kind: "profile", dedupeKey: "#X", payload: { tag: "#X" } });
await core.enqueue({ kind: "profile", dedupeKey: "#X", payload: { tag: "#X" } });
const [{ n }] = await sql`select count(*)::int n from job where kind = 'profile' and dedupe_key = '#X'`;
assert.equal(n, 1, "dedupe on queued");
const jobs = await core.claim(["profile"], 10);
assert.equal(jobs.length, 4, "3 new roster players + #X");
const x = jobs.find((j) => j.dedupeKey === "#X")!;
await core.retryLater(x, 0, "429", false, 5);
const again = (await core.claim(["profile"], 10)).find((j) => j.dedupeKey === "#X")!;
assert.equal(again.attempts, 1, "RetryLater does not burn attempts");

// season ended -> member log queue: probes done, others queued; top-ranked first
const queued = await core.queueMemberLogs(SEASON, "#GRP1");
console.log("memberlog jobs queued:", queued);
assert.equal(queued, 1, "only #CCC still lacks a final log");

// analytics on the synthetic season (needs league_group rows, which discoverGroup normally creates)
await sql`insert into league_group (season_id, group_tag, tier_id, probe_player_tag) values (${SEASON}, '#GRP1', 105000033, '#AAA') on conflict do nothing`;
await core.rebuildSeason(SEASON); await core.refitExpectedStars(); await core.scoreSeason(SEASON);
const tl = await sql`select player_tag, source, delta, trophies_after from trophy_timeline where player_tag = '#AAA' order by seq`;
console.table(tl);
// #AAA: +40 (3-star on BBB), +23 (73% 2-star on CCC), +40 (CCC attacked with 0 stars -> defender gets 40)
assert.deepEqual(tl.map((r) => r.trophies_after), [40, 63, 103]);
const st = await sql`select attacks, avg_stars, three_star_rate, near_miss_rate, log_complete, perf_vs_expected from player_season_stats where player_tag = '#AAA'`;
console.table(st); assert.equal(st[0].attacks, 2); assert.equal(st[0].three_star_rate, 0.5); assert.equal(st[0].log_complete, true);
const gs = await sql`select n, avg_trophies, top10_share, basis from group_stats`; console.table(gs); assert.equal(gs[0].n, 3);
const rec = await sql`select * from trophy_reconciliation`; console.table(rec);
// cleanup: out-of-scope group (tier 25) with queued jobs and members
await sql`insert into league_group (season_id, group_tag, tier_id, probe_player_tag) values (${SEASON}, '#OOS', 105000025, '#ZZZ')`;
await sql`insert into group_member (season_id, group_tag, player_tag, trophies) values (${SEASON}, '#OOS', '#ZZZ', 1)`;
await core.enqueueMany([{ kind: "roster", dedupeKey: "oos", payload: { seasonId: SEASON, groupTag: "#OOS", probeTag: "#ZZZ" } }, { kind: "history", dedupeKey: "#ZZZ", payload: { tag: "#ZZZ" } }, { kind: "history", dedupeKey: "#AAA2", payload: { tag: "#AAA" } }]);
const dry: any = await core.cleanupOutOfScope({ apply: false, purgeData: false });
assert.equal(dry.outOfScopeGroups, 1); assert.equal(dry.queuedGroupJobsToDelete[0].n, 1); assert.equal(dry.queuedPlayerJobsToDelete[0].n, 1, "only #ZZZ's job, not in-scope #AAA's");
await core.cleanupOutOfScope({ apply: true, purgeData: true });
assert.equal((await sql`select count(*)::int n from league_group where tier_id = 105000025`)[0].n, 0);
assert.equal((await sql`select count(*)::int n from job where dedupe_key in ('oos', '#ZZZ')`)[0].n, 0);
assert.equal((await sql`select count(*)::int n from job where dedupe_key = '#AAA2'`)[0].n, 1, "in-scope work survives");
const cov = await sql`select * from coverage_by_season`; console.table(cov);
const res = await sql`select * from player_season_result limit 1`; // view compiles
console.log("OK: schema, ingest, dedupe, queue, coverage view all work");
await sql.end(); await server.stop(); process.exit(0);
