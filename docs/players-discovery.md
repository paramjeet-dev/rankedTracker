# Player discovery (`players-discovery`)

Mirrors ClashKing's `globalclans`: it keeps the clan and player catalogue current. It is the durable owner of
clan rosters and of which players are in ranked scope (`league_tier.in_scope`, Titan 26 to Electro 33).

## What it owns

`clan.members_crawled_at`, `name`, `member_count`, the retry state (`fail_count`, `next_attempt_at`,
`invalid_at`), and the insertion of in-scope players into `player`. It does not fetch player profiles, league
history, groups or battles, and it does not write `player.name` for existing players (name history belongs to
the profile process).

## When it runs

Continuously, as two pools with separate cursors and separate request budgets:

- **new**: clans never crawled (`members_crawled_at IS NULL`). Default 10 requests/s, 20 in flight.
- **refresh**: clans crawled more than `DISCOVERY_REFRESH_DAYS` (7) ago. Default 2 requests/s, 4 in flight.

A pool that finds nothing left sleeps (30 s for new, 10 min for refresh), then starts a new pass.

## How a clan becomes a target

Keyset pagination over the `clan` table, ordered by `clan_tag`, 500 per page, resuming after the last tag read.
A clan is eligible when `invalid_at IS NULL` and (`next_attempt_at IS NULL` or in the past). There is no job
table: the 158,695 queued `clan_members` rows are simply the clans with `members_crawled_at IS NULL`. A partial
index (`clan_never_crawled_idx`) keeps the "new" page query around 2 ms at that size.

Worker loops share one async generator, so requests flow continuously. A slow clan never holds up the next page.

## Decision flow

```
page of clan tags -> GET clan (one call returns the whole roster, up to 50 members, with each member's leagueTier)
  ok            -> in one transaction:
                     in-scope members: insert new players, update tier_id/last_seen only when changed
                     out-of-scope members already in the catalogue: update tier_id only (never insert)
                     clan: name, member_count, members_crawled_at = now(), fail_count = 0
  404 / 400     -> invalid_at = now() (stop targeting)
  500 / timeout -> fail_count + 1, next_attempt_at = now() + 2^fail_count minutes (cap 6 h), this clan only
  outage / auth -> nothing written; the shared gate pauses everyone and the clan stays a target
```

Scope filtering matters: crawling every roster would otherwise insert millions of out-of-scope players.

## Clash API used

`GET /clans/{clanTag}` via `client.rest.getClan`. No profile, history, group or battle endpoint.

## Data read and written

Reads `clan`. Writes `clan` (columns above) and `player` (`player_tag`, `name` on first insert only, `tier_id`,
`last_seen`). Player rows are upserted in one set-based statement sorted by tag, so concurrent transactions lock
in the same order and cannot deadlock. An unchanged roster causes no row writes (`last_seen` is refreshed at most
once a day).

## Valkey and events

Uses the shared availability gate and writes `tracking:metrics:players-discovery:<pool>`. Publishes no events.

## Configuration

- `POOL_PLAYERS_DISCOVERY_NEW_RPS` / `_MAX_IN_FLIGHT`, `POOL_PLAYERS_DISCOVERY_REFRESH_RPS` / `_MAX_IN_FLIGHT`
- `DISCOVERY_REFRESH_DAYS`
- `PG_POOL_MAX` (default 8), `DATABASE_URL`, `VALKEY_URL`, Clash credentials

## Outages and restarts

Every request waits at the shared gate. A restart begins each pool from the first tag again; unchanged-row checks
make that safe. On start the process refuses to run if stored tags do not start with `#`, because writing then
would create duplicate rows.

## What it deliberately does not do

- It does not fetch player profiles or decide who gets history-backfilled (`players-profile`).
- It does not find new clans. They enter `clan` from the clan leaderboard seed, from player profiles
  (`players-profile`) and from stored league groups (`groups`).
- It does not publish events and does not own notification or group state.
