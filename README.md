# CoC Ranked Mode Tracker: Phase 0

Requires Docker and Node 20+. Windows PowerShell commands, run from this folder.

## First-time setup
    copy .env.example .env             # then edit .env: COC_EMAIL, COC_PASSWORD
    docker compose up -d               # Postgres, schema auto-loaded on first start
    npm install
    docker compose exec db psql -U coc -d coc -c '\dt'      # expect 12 tables
    npm run seed-tiers                 # expect "seeded 37 tiers"
    docker compose exec db psql -U coc -d coc -c "SELECT * FROM league_tier WHERE in_scope;"   # expect 8 rows (105000026..105000033)

## Checks
    npm run smoke -- '#PLAYERTAG'      # expect ALL OK
    npm run probe -- '#PLAYERTAG'      # expect one "ok" line per group
    docker compose exec db psql -U coc -d coc -c "SELECT * FROM retention_probe ORDER BY probed_at;"

## Notes
- Login uses email/password via clashofclans.js, so API keys follow the current IP.
- League group call: /leaguegroup/{groupTag}/{seasonId}?playerTag={playerTag}
- Re-run the probe after each Monday rollover (Spike E).
- Season id = season START (epoch seconds, Monday 05:00 UTC); end = start + 7 days.
- getLeagueHistory is oldest first and excludes the ongoing season.

## Reset the database
Existing DB from an older schema: apply db/migrations/001_tier_ids.sql.
Full wipe: `docker compose down -v`, then `docker compose up -d`, then `npm run seed-tiers`.


## How it works
- Job kinds: `clan_members` -> `profile` -> (`group_fetch` current group, `history_backfill` -> `group_fetch` previous group).
- `group_fetch` stores the full roster plus the attack/defense logs of the requested player only, then queues the other members; each battle shows up in two logs and is deduped by the primary key.
- Only groups whose tier is Titan..Electro (`league_tier.in_scope`) are fetched. Legend groups are skipped entirely.
- The crawler auto-queues a sweep 10 minutes after each Monday 05:00 UTC rollover: every member of every unfinished group of the finished season is re-fetched so logs are final. Keep the PC on and the crawler running at that time. Manual: `npm run sweep -- <seasonId>`.
- Group status: `pending` (season still running), `complete` (stored battles >= expected), `incomplete` (season over, some logs unreachable).
- Trophy cross-check: when the same battle is seen from both sides, the crawler compares the trophy values and prints `trophy mismatches` if the "defender = 40 - attacker" assumption is wrong.
