# League groups (`groups`)

Mirrors the CWL checker. Registers every league group the tracker learns about, once, with its roster.

## What one API call returns

`GET /leaguegroup/{groupTag}/{seasonId}?playerTag=...` returns the whole roster (every member's trophies and
attack/defense counts) plus the attack and defense logs of that ONE player. Registering a group therefore costs one
call, and collecting the rest of a finished season's battles later costs more calls with different member tags
(that is `battles`, Phase E).

## What it owns

`league_group` (tier, `expected_battles` = sum of the members' attack wins + losses, `fetched_at`), the roster in
`group_member`, the clans and players found in the roster (with `player_name_history` for new or renamed players),
the battles in the logs of the one player the call was made for, and `group_fetch_state` (attempts that did not
produce a group).

## Targets

A query, not a queue. The groups players' profiles point at, that are not stored yet:

- the current group, when the player's current tier is in scope;
- the previous group, when that player's finished-season result for the previous season is in scope (the history
  call is what gives the previous season's tier, which is also stored as the group's tier);
- one representative player per `(group_tag, season_id)` (sibling exclusion; the lowest player tag);
- not groups already in `league_group`, groups marked gone, or groups still backing off.

Keyset cursor on `(group_tag, season_id)`, 500 per page. The page query takes about 0.5 s at 180,000 players,
negligible next to the roughly 60 s of API calls a page represents.

## Flow

```
GET getLeagueGroup(groupTag, seasonId, { playerTag })
  ok            -> one transaction: season, group, clans, players (+ name history), roster, battles, which member was logged
  404 / 400     -> group_fetch_state.gone_at (the API does not serve it); never retried
  500 / timeout -> fail_count + 1, back off 2^fail_count minutes (cap 6 h)
  outage / auth -> nothing written; the shared gate pauses everyone and the group stays a target
```

## Storage rules

- A battle is in two logs. The primary key `(season_id, attacker_tag, defender_tag, battle_time)` merges them: the
  first sighting inserts the row, the second only fills in the other side's trophy value.
- `league_group.stored_battles` is incremented by the number of rows genuinely inserted, so it stays exact
  without scanning the season's partition.
- The battle partition for a season is created outside any transaction (it takes a strong lock on `battle`).
- Every write is skipped when nothing changed: storing the same response twice writes nothing, and a roster
  refresh writes only members whose numbers moved. A deadlock rolls the whole transaction back and retries it.
- New clans are inserted with `members_crawled_at IS NULL`, which makes them targets for `players-discovery`.
  Group-mates become `player` rows and are picked up by `players-profile`.

## Endpoint and budget

`client.rest.getLeagueGroup(tag, seasonId, { playerTag })` (supported by clashofclans.js 5.1.0). Pool `groups`,
default 8 calls/s and 16 in flight (`POOL_GROUPS_RPS`, `POOL_GROUPS_MAX_IN_FLIGHT`).

## Does not

Collect the remaining members' logs of a finished season, set `complete` / `incomplete`, fetch profiles, or crawl
clan rosters. Running-season logs for priority players (app users) are deferred until there are app users.
