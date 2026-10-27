# Phase B: clan roster discovery

Adds `players-discovery`, the `migrate` runner, `sql/001_discovery_state.sql` and tests. Needs Phase A installed.
It overwrites `src/shared/config.ts` (new scope/discovery settings and the key-name default), `docs/README.md`,
`docs/players-discovery.md`, `.env.example` and `package.additions.json`; if you edited config.ts, merge instead.

## 1. Copy and configure

Copy the zip contents over the repo. Add the new `.env.example` lines to `.env`.

**Set `CLASH_KEY_NAME` to the key name your old crawler uses** (the library default is `clashofclans.js.keys`
unless your code passes `keyName`). Your account has COC_KEY_COUNT=10 keys, which is the developer-portal maximum;
a different name would try to create 10 more keys and fail.

## 2. Migrate and test

```
npm run migrate      # applies sql/001_discovery_state.sql (additive; the old crawler ignores the new columns)
npm run typecheck
npm test             # integration tests skip unless TEST_DATABASE_URL is set; point it at a throwaway copy, never your real DB
```

The integration tests TRUNCATE tables. Do not point TEST_DATABASE_URL at your real database.

## 3. Run

Stop the old crawler first so the two do not compete for the same keys and clans, then in separate terminals:

```
npm run availability
npm run discovery
```

Watch the first 10 minutes. Healthy output looks like:

```
[metrics] players-discovery-new rps=9.8 (limit 10.0/10.0) ok=290 err=3 avg=210ms
[players-discovery] [new] remaining=158102 clansOk=593 playersInserted=...
```

At 10 rps the 158,695 queued clans take about 4.4 hours; at 40 rps about 66 minutes. If errors stay near zero,
raise `POOL_PLAYERS_DISCOVERY_NEW_RPS` in steps (10, 20, 40). A current limit below the ceiling in the metrics
line means the pacer is backing off because of 429s, timeouts or gateway errors.

## What to check afterwards

```sql
SELECT count(*) FILTER (WHERE members_crawled_at IS NULL AND invalid_at IS NULL) AS remaining,
       count(*) FILTER (WHERE invalid_at IS NOT NULL) AS invalid,
       count(*) FILTER (WHERE fail_count > 0) AS retrying
FROM clan;
SELECT tier_id, count(*) FROM player GROUP BY 1 ORDER BY 1;
```
