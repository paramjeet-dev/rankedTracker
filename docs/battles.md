# Battle collection (`battles`)

Mirrors the war archiver. Collects every battle of a finished season, using the same league-group endpoint as
`groups`, and settles each group's status.

## How battles are collected

Every battle is in two logs (the attacker's and the defender's), and a group call returns the logs of one member.
So members are fetched one at a time, **most active first** (`attack_wins + attack_losses + defense_wins +
defense_losses`), and collection **stops as soon as `stored_battles >= expected_battles`**. That usually needs well
under half of the members. A member whose logs were already fetched after the season ended (for example the one
`groups` used to register the group) is skipped; members fetched before the season ended are fetched again.

Stopping early means a few battles have only one side's raw trophy value. `battle_resolved` derives the missing side
from the game's rules, as before.

## Targets

A query, not a queue: groups of seasons that ended more than 10 minutes ago (the delay lets the final rankings
settle), in scope, whose status is not `complete`, that have not been settled (`collected_at IS NULL`) and are not
backing off. Newest season first, because old data is the data the API can stop serving. Keyset cursor on
`(season_id, group_tag)`, descending. This replaces the Monday sweep that queued one job per group.

The first group touched in a season stamps `season.swept_at`, so the old crawler's own sweep sees the season as swept
and queues nothing if it is still running.

## Per group

```
beginGroup (swept_at)
loop: member = most active member whose logs are missing or older than the season end, not visited this run
  ok            -> store (roster, battles, which member was logged); stop if stored >= expected
  not found     -> next member; 3 in a row (no success between) means the API no longer serves the group: stop
  other permanent error -> skip this member
  500 / timeout (after retries) -> back the group off (collect_fail_count, collect_next_attempt_at), resume later
  outage / auth -> pause: nothing settled, the group stays a target
finalize: status = pending (season not over) | complete (stored >= expected) | incomplete, collected_at = now()
```

Progress lives in the database (`group_member.logs_fetched_at`), so an interrupted group resumes with only the
members still missing and never refetches one that was already collected. The same group is never collected by two
workers at once.

Deviation from the old loop: it tried every remaining member after a failure; here three consecutive "not found"
answers end the group early, so an expired group costs 3 calls instead of one per member.

## Status rules (unchanged)

`pending` while the season runs, `complete` when `stored_battles >= expected_battles`, otherwise `incomplete`
(some logs are no longer served). Settled groups are not collected again automatically. To retry one:

```sql
UPDATE league_group SET collected_at = NULL, collect_fail_count = 0, collect_next_attempt_at = NULL
 WHERE group_tag = '#TAG' AND season_id = '1791781200';
```

## Storage

Done by `GroupStore` (shared with `groups`): one battle partition per season created outside any transaction, rows
merged by the primary key, no-op writes skipped, deadlocks retried.

## Configuration

Pool `battles`: `POOL_BATTLES_RPS` (20) and `POOL_BATTLES_MAX_IN_FLIGHT` (40). `BATTLES_WORKERS` (24) is how many
groups are collected at once (each group is sequential). The process raises its Postgres pool to at least
min(workers, 24) connections. Migration `sql/005_battle_collection.sql` adds the three `league_group` columns and
marks groups the old crawler already settled as collected.

## Retention

Old groups can stop being served (HTTP 404); those end as `incomplete`. Run this process through every Monday
rollover window: battle data that is no longer served cannot be recovered later. `retention-probe` keeps measuring
how long data stays available.

## Does not

Register groups (`groups`), fetch profiles, crawl clan rosters, or collect the running season's logs for priority
players (deferred until there are app users).
