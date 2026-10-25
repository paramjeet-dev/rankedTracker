# Ranked Mode History Tracker

Collects Clash of Clans Ranked Battles history (Titan League 26 to Electro League 33) into PostgreSQL:
season summaries per player, group rosters, and every battle with both sides' trophies.
Legend groups are skipped.


## Commands

| command | what it does |
|---|---|
| `npm run crawl` | the crawler (queue workers + automatic Monday sweep) |
| `npm run seed -- '#TAG' ...` | queue priority players; add `--clans 200` for more clans per country, `--no-clans` for tags only |
| `npm run stats` | queue, groups per season and status, totals, recent failures |
| `npm run trophies` | checks the trophy rules against the stored data |
| `npm run inspect -- '#GROUP' <seasonId>` | re-fetches one group from the API and lists battles that break the trophy rules |
| `npm run sweep -- <seasonId>` | manually queue the post-season battle collection |
| `npm run probe -- '#TAG'` | records whether old groups are still fetchable (run after each Monday rollover) |
| `npm run typecheck` | TypeScript check |

## How it works

Everything is a job in the `job` table, so the crawler can be stopped and resumed at any time.

1. `clan_members`: roster of a clan, keeps members whose tier is Titan..Electro
2. `profile`: player row, current group, clan; queues the history job
3. `history_backfill`: all finished seasons of that player; queues the previous group if its tier is in scope
4. `group_fetch`: one job per group
   - season still running: stores the roster only (1 API call). Battle logs are collected after the season ends.
     Exception: players seeded with `npm run seed -- '#TAG'` get their running group's logs too.
   - season finished: fetches members one at a time, most active first, and stops as soon as every battle of
     the group is stored. Each battle is in two logs (attacker's and defender's), merged by primary key.
5. About 10 minutes after each Monday 05:00 UTC rollover the crawler queues one `group_fetch` per unfinished group
   of the finished season. **Keep the PC on and the crawler running then.** If it was off, it queues the sweep at the
   next start (battle logs of very old groups may no longer be available from the API).

Group status: `pending` (season running), `complete` (all battles stored), `incomplete` (season over, some logs missing).

## Trophy rules (stored raw, derived when one side is missing)

- Attacker: 3 stars = 40, 2 stars = 16 + (destruction - 50) / 3, 1 star = 5 + (destruction - 1) / 9, 0 stars = up to 4.
- Defender: 40 minus the attacker's trophies, except a 0-star attack gives the defender the full 40.
- `battle` holds the raw values from the logs (`attacker_trophies`, `defender_trophies`, NULL when that side's log was not fetched).
- `battle_resolved` (view) fills the missing side with the rules above; `trophy_source` says which.
- `npm run trophies` compares the rules with the real data; any "bad" count means a rule needs a look.

## Configuration (.env)

| variable | default | meaning |
|---|---|---|
| `COC_EMAIL`, `COC_PASSWORD` | | developer portal login; keys are created automatically |
| `COC_KEY_COUNT` | 10 | API keys to use (portal maximum is 10) |
| `COC_RATE_PER_KEY` | 20 | requests per second per key; lower it if you see many 429 errors |
| `CRAWL_CONCURRENCY` | 32 | parallel workers |
| `DB_POOL` | 40 | Postgres connections, keep >= workers |
| `LIVE_LOGS` | false | true = also collect battle logs while a season is running |
| `COLLECT` | cover | `all` = fetch every member of every group (more calls) |
| `DISCOVER_GROUPMATES` | false | true = also profile every group-mate (many more calls) |

## Checking things directly

    docker compose exec db psql -U coc -d coc -c "SELECT kind, status, count(*) FROM job GROUP BY 1,2 ORDER BY 1,2;"
    docker compose exec db psql -U coc -d coc -c "SELECT status, count(*) FROM league_group GROUP BY 1;"
    docker compose exec db psql -U coc -d coc -c "SELECT * FROM battle_resolved ORDER BY battle_time DESC LIMIT 10;"
