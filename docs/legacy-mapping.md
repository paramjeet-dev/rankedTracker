# Mapping from the single-queue crawler to the processes

The original crawler (`src/crawler.ts`) runs four job kinds in one process through the `job` table. The redesign
keeps every rule and replaces the queue with queries over state columns, one process per workload.

| Old job kind / code | New process | Notes |
| --- | --- | --- |
| `clan_members` (`runClanMembers`) | `players-discovery` (Phase B) | Targets: clans with `members_crawled_at IS NULL`. Only in-scope members are inserted. It no longer queues profile jobs: `players-profile` finds new players by query. |
| `profile` (`runProfile`) | `players-profile` (Phase C) | Also upserts the player's clan. The group tags it used to turn into `group_fetch` jobs are stored on `player` for `groups`. |
| `history_backfill` (`runHistory`) | `players-profile` (Phase C) | Merged with the profile into one visit and one transaction. |
| `group_fetch`, season running | `groups` (Phase D) | Roster plus the called player's logs, one call per group. Group tags come from `player.current_group_*` and `previous_group_*`. |
| `group_fetch`, season finished (cover loop) and the Monday sweep | `battles` (Phase E) | Same endpoint and rules; targets by query instead of a sweep that queues jobs; resumable; stops early on groups the API no longer serves. |
| `seed` (clan leaderboards) | `npm run seed-clans` | Writes `clan` rows directly instead of queueing jobs. |
| `seed` (app users, `full`) | deferred | No app users yet; a priority flag is added when there are. |
| queued jobs in `job` | `npm run import-queue` | One-off: copies queued clan and player tags into the catalogue tables. |
| `finalizeGroup` | `battles` | Status rules unchanged: pending / complete / incomplete. |
| `retention-probe`, `trophies`, `inspect-group` | unchanged | Read-only tools. |
| `stats` | unchanged for now | Reads the `job` table; needs a rewrite when that table is retired. |

## Rules carried over unchanged

- Scope is `league_tier.in_scope` (Titan 26 to Electro 33); Legend and below are skipped.
- `group_member` stats are overwritten on every group response; battles are merged from the attacker's and the
  defender's logs by the primary key (`season_id, attacker_tag, defender_tag, battle_time`).
- `expected_battles` = sum over members of `attack_wins + attack_losses` from the group response.
- Season ids are start times (Monday 05:00 UTC); a season is over when `now >= start + 7 days`.
