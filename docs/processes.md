# Process dossiers

Same shape as ClashKingTracking's docs: what each process owns, how it picks targets, which endpoint it calls, what it writes, what it leaves to others.
All processes are independent (`pm2 start ecosystem.config.cjs`, or run one with `node --import tsx apps/<name>/src/index.ts`). They share only Postgres
(job queue + `system_state`) and the VPS gateway. Each has its own `RPS_*`; every Clash call goes through the process-local gate.

| Process | Owns | Picks targets from | Endpoint | Writes | Leaves to others |
|---|---|---|---|---|---|
| availability | shared "may we call Clash?" state | timer (15s) | `/locations?limit=1` | `system_state` | everything else |
| scheduler | clocks and housekeeping (no API calls) | timer (60s) | none | jobs, `system_state`, group tier backfill, raw pruning, weekly discovery + history refresh | fetching |
| seeds | discovery from leaderboards | `seed_locations` / `seed` jobs | `/locations`, `/locations/{id}/rankings/players` | `player`; queues `profile`, `history` | group discovery |
| profile | a player's current + previous league group refs | `profile` jobs | `/players/{tag}` | `player`, `player_snapshot`, `league_group`; queues `roster` | rosters, logs |
| history | layer A | `history` jobs | `/players/{tag}/leaguehistory` | `player_season` | groups |
| roster | layer B (+ probe's battles) | `roster` jobs | `/leaguegroup/{group}/{season}` | `group_member`, `battle`, `player`; queues `memberlog` (ended seasons only), `history`/`profile` for new players | other members' logs |
| memberlog | layer C | `memberlog` jobs | same endpoint, member as probe | `group_member` (refresh), `battle` | discovery |
| aggregator | derived tables (no API calls) | new battles per recent season | none | `trophy_timeline`, `player_season_stats`, `player_hour_hist`, `expected_stars_model`, `group_stats` | serving |

## Gate semantics (copied from ClashKingTracking)
- `availability` distinguishes official maintenance from a proxy outage. Neither shifts any clock here (no war timers), both pause work.
- The first process to see an outage closes its own gate immediately; it reopens only after a healthy heartbeat newer than the closure.
- Heartbeat older than 45s counts as unknown: workers fail open, but real errors still close their local gate.
- A failed target stays queued (backoff) and is retried; `RetryLater` signals (429, maintenance, gateway queue full) never consume attempts.

## Season-end sweep (scheduler)
At rollover the scheduler runs three passes (+0h, +24h, +72h) over every group of the ended season: it clears `roster_fetched_at` and re-queues the roster job at priority 1;
the roster worker then queues all missing member logs (top 5 = priority 1, promotion/demotion bubble = 2, rest = 3). Re-running a pass is safe (dedupe + `ON CONFLICT`).

## Known unknowns (fail loudly, raw is saved)
`packages/core/src/parse.ts` and `endpoints.ts` hold every assumption about payload shapes and the group endpoint's query-param form. A mismatch throws
`ParseError`, fails the job at once, and the raw response stays in `data/raw/` for reprocessing.

## Weekly upkeep (scheduler, every 5 min; `packages/core/src/discovery.ts`)
- **New-group discovery.** Groups reshuffle each season, so the only way to a new group is a member's profile. While the current season has fewer known groups than
  `DISCOVERY_TARGET_PCT` (99) of the largest season seen, it queues a batch (`DISCOVERY_BATCH`, 25000; max `DISCOVERY_MAX_BATCHES`, 10 per season) of profile jobs at priority 0
  for random members of the most complete past season not yet profiled this season. The next batch waits until the previous one has mostly drained.
- **Post-season history refresh.** At +1h/+24h/+72h after a season ends, queues `history` (priority 3) for every member of that season with no `player_season` row for it.
- State lives in `system_state` keys `discovery` and `history_refresh`. Raise `RPS_PROFILE` and `RPS_HISTORY` for the Monday catch-up (about 100k profiles + up to ~2M histories on a first run).
