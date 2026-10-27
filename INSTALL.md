# Installing the redesign (Phases A to E)

Everything here is additive: your `job` table, `src/` files and `db/schema.sql` are untouched, so the old crawler
still works until you switch it off. New processes: `availability`, `discovery`, `profile`, `groups`, `battles`,
plus `migrate`, `seed-clans` and `import-queue`.

## 1. Copy the files

Unzip into the repo root (`rankedTracker/`). New folders: `src/shared`, `src/discovery`, `src/profile`, `src/groups`,
`src/battles`, `src/processes`, `sql`, `test`, `docs`. Nothing in your existing `src/*.ts` is overwritten
(`src/shared/db.ts` is a different file from your `src/db.ts`). Your repo is already `"type": "module"` with NodeNext,
which this code was typechecked against.

## 2. Dependencies, scripts, env, Valkey

```
npm i ioredis
```

Merge the `scripts` from `package.additions.json` into `package.json`. Merge `.env.example` into `.env`;
`CLASH_EMAIL` / `CLASH_PASSWORD` / `CLASH_KEY_COUNT` and your old `COC_*` names are both accepted. Leave
`CLASH_KEY_NAME` unset: your old code never passed a key name, so your 10 keys carry the library default, and a
different name would try to create 10 more.

Merge `docker-compose.valkey.yml` into your `docker-compose.yml`, then `docker compose up -d valkey`.

## 3. Migrate and test

```
npm run migrate        # applies sql/001..005 once each, recorded in tracking_migrations
npm run typecheck
npm test               # database tests are skipped unless TEST_DATABASE_URL is set
```

The migrations add nullable columns, one table and indexes only; 005 also marks groups the old crawler already
settled (`complete` / `incomplete`) as collected. `npm run migrate` also works on a fresh database after
`db/schema.sql`. **Database tests TRUNCATE tables: point `TEST_DATABASE_URL` only at a throwaway database.**

## 4. Check your data before the first run

```sql
SELECT season_id, starts_at, ends_at, ends_at - starts_at AS len FROM season ORDER BY season_id DESC LIMIT 3;
SELECT tier_id, in_scope FROM league_tier WHERE in_scope ORDER BY 1;
SELECT player_tag FROM player LIMIT 2;
```

Seasons must be "id = start time, 7 days long", `league_tier` must have the Titan..Electro range flagged
(`npm run seed-tiers`), and tags must start with `#`. The new processes refuse to start otherwise.

## 5. Move over from the old crawler

1. Stop `npm run crawl`.
2. Copy the work it had queued, so nothing is lost. A queued clan or profile job only holds a tag; its row is created
   when the job runs, so those tags have no row yet:
   ```
   npm run import-queue            # dry run: shows how many tags have no row
   npm run import-queue -- --apply
   ```
3. Clean up the developer keys once: open https://developer.clashofclans.com, and delete the keys you do not need (the
   account allows 10 in total; unused ones from other names or old IPs block new ones).
4. Start `availability` FIRST, in its own terminal, and wait for `published key set v1 (N keys)`. It is the only
   process that logs in; the others follow its keys (see `docs/keys.md`). Then, each in its own terminal:
   ```
   npm run discovery
   npm run profile
   npm run groups
   npm run battles
   ```
   If your public IP changes every few minutes, see "If the IP itself keeps changing" in `docs/keys.md`.
5. To seed a fresh database (or add more clans), `npm run seed-clans` replaces `npm run seed`: it writes the top clans
   of every country straight into `clan`. Priority app users are deferred until you have some.

Defaults: discovery 10 requests/s (about 4.4 h for 158,695 clans), profile 12 calls/s (about 8 h for 180,000 players,
two calls each), groups 8 calls/s, battles 20 calls/s with 24 groups at a time. Raise the `POOL_*_RPS` values in steps
while the metrics line shows errors near zero and the current limit equal to the ceiling. Keep the sum of all pool
ceilings below your old budget of `COC_RATE_PER_KEY x key count` (20 x 10 = 200). Defaults add up to 54.

Battle data from old groups can stop being served by the API, so `battles` is the one process worth keeping running
across every Monday 05:00 UTC rollover. At that moment every player visited so far also becomes eligible for the
profile refresh pool, which picks up their new group tags.

## 6. Check progress

```sql
SELECT count(*) FILTER (WHERE members_crawled_at IS NULL AND invalid_at IS NULL) AS clans_remaining,
       count(*) FILTER (WHERE invalid_at IS NOT NULL) AS clans_invalid FROM clan;
SELECT count(*) FILTER (WHERE history_backfilled_at IS NULL AND invalid_at IS NULL) AS players_remaining,
       count(*) FILTER (WHERE current_group_tag IS NOT NULL) AS with_current_group FROM player;
SELECT season_id, status, count(*) AS groups, sum(stored_battles) AS stored, sum(expected_battles) AS expected
FROM league_group GROUP BY 1, 2 ORDER BY 1 DESC, 2 LIMIT 12;
```

To collect one settled group again, see "Status rules" in `docs/battles.md`.
