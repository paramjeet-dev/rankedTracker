# Player profiles and season history (`players-profile`)

Mirrors ClashKing's `basicplayers`: owns the per-player facts that need one visit each.

## What it owns

`player.name` (with `player_name_history`), `tier_id`, `profiled_at`, `history_backfilled_at`, the current and
previous league group tags, the retry state (`fail_count`, `next_attempt_at`, `invalid_at`), and the
`player_season_result` and `season` rows that come from league history, and the player's clan row (so a clan seen
only on a profile still reaches `players-discovery`). It does not discover players, fetch groups, or fetch battles.

## A visit

One visit is two calls, saved in one transaction:

```
GET /players/{tag}                 -> name, league tier, current/previous league group tag and season id
GET /players/{tag}/leaguehistory   -> finished-season results (placement, wins, losses, stars, trophies)
  both ok     -> clan row, name history (old and new name), season rows, season results, player row, in one transaction
  history 404 -> treated as "no history"; the visit still completes
  player 404  -> invalid_at = now()
  500/timeout -> nothing saved; fail_count + 1, next_attempt_at = now() + 2^fail_count minutes (cap 6 h)
  outage/auth -> nothing written; the shared gate pauses everyone and the player stays a target
```

Nothing is saved on a partial failure, so `history_backfilled_at` always means "profile and history were both
current when this player was last visited". (The column name is historical; read it as "last complete visit".)

## Two pools

Same pattern as discovery: keyset pagination by tag, 500 per page, separate cursors and budgets.

| Pool | Targets | Default budget (calls/s, in flight) |
| --- | --- | --- |
| new | `history_backfilled_at IS NULL` | 12, 24 |
| refresh | last complete visit before the current season started | 4, 8 |

Both exclude invalid and backed-off players and players whose stored tier is outside scope (unknown tier is
included). Scope is `league_tier.in_scope`. The current season start is computed in SQL from the newest stored season id plus whole weeks (ids are
start times, Monday 05:00 UTC), so the refresh wave begins at rollover even before any new group is stored. Each
player is visited about once a week, which is how new group tags and newly finished seasons are picked up.

Players the old crawler already profiled have no `history_backfilled_at`, so the new pool revisits them once
(about 2,400 calls). Existing season rows are rewritten only if a value differs.

## Writes

- `clan`: the player's current clan, inserted if new (crawl state untouched) and renamed only if the name changed.
- `player`: name, tier_id, profiled_at, history_backfilled_at, last_seen, `current_group_tag`,
  `current_group_season_id`, `previous_group_tag`, `previous_group_season_id`, reset retry state. Empty tags are
  stored as NULL. The `groups` process reads the group tags from here.
- `player_name_history`: the previous and the current name (primary key player + name, so repeats are ignored).
- `season`: missing rows only (`id = start time`, `ends_at = start + 7 days`), sorted so concurrent visits cannot
  deadlock.
- `player_season_result`: upsert that rewrites a row only when a value actually differs. By default only seasons
  in scope tiers are kept (`HISTORY_SCOPE_ONLY=false` keeps everything). The API returns 0 for `attackStars` in
  finished seasons, so it is not stored.

## Startup checks

The process refuses to start if stored tags do not start with `#`, or if existing `season` rows do not follow
"id = start time, one week long", because it would then write rows inconsistent with the existing data.

## Configuration

`POOL_PLAYERS_PROFILE_NEW_RPS` / `_MAX_IN_FLIGHT`, `POOL_PLAYERS_PROFILE_REFRESH_RPS` / `_MAX_IN_FLIGHT`,
`HISTORY_SCOPE_ONLY`, `SEASON_SECONDS` (604800), `PG_POOL_MAX`.
Budgets are calls per second; a visit is two calls.

## What it deliberately does not do

- It does not discover players (`players-discovery` does) or fetch groups or battles.
- It does not fetch the previous season's group; it only records the tag for `groups`.
- It does not publish events.
