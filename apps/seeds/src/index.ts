/** Seeds: location leaderboards -> players -> profile jobs. NOTE: verify these leaderboards actually contain ranked-mode participants. */
import { runWorker, cocGet, locationsPath, rankingsPath, enqueueMany, sql, envNum } from "@coc/core";
import { normalizeTag } from "@coc/shared";
process.env.PROC_NAME ??= "seeds";

await runWorker({ name: "seeds", kinds: ["seed_locations", "seed"], concurrency: 2, rps: envNum("RPS_SEEDS", 5), handlers: {
  async seed_locations() {
    const j = await cocGet(locationsPath(), { kind: "locations", key: "all" });
    const ids: (string | number)[] = ["global", ...j.items.filter((l: any) => l.isCountry).map((l: any) => l.id)];
    await enqueueMany(ids.map((id) => ({ kind: "seed", dedupeKey: String(id), payload: { locationId: id }, priority: 6 })));
  },
  async seed(job) {
    const { locationId } = job.payload; let after: string | undefined;
    for (let page = 0; page < 5; page++) { // top ~1000 per location
      const j = await cocGet(rankingsPath(locationId, after), { kind: "rankings", key: `${locationId}:${page}` });
      const tags: string[] = (j.items ?? []).map((i: any) => normalizeTag(i.tag));
      if (tags.length) {
        const names = new Map<string, string>((j.items ?? []).map((i: any) => [normalizeTag(i.tag), i.name]));
        const rows = await sql<{ tag: string; inserted: boolean }[]>`
          insert into player (tag, name) select t.tag, t.name from jsonb_to_recordset(${sql.json(tags.map((t) => ({ tag: t, name: names.get(t) })) as any)}::jsonb) as t(tag text, name text)
          on conflict (tag) do update set name = excluded.name returning tag, (xmax = 0) as inserted`;
        // seeds are re-profiled every run (their group tags change weekly); history only once
        await enqueueMany(rows.flatMap((r) => [
          { kind: "profile", dedupeKey: r.tag, payload: { tag: r.tag }, priority: 4 },
          ...(r.inserted ? [{ kind: "history", dedupeKey: r.tag, payload: { tag: r.tag }, priority: 5 }] : [])]));
      }
      after = j.paging?.cursors?.after; if (!after) break;
    }
  } } });
