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
