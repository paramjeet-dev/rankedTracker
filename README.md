# coc Tracker v2

Local ingestion + Postgres, with a VPS gateway holding the API keys (static IP).

## Run
1. `cp .env.example .env` and fill it in.
2. **VPS:** copy `apps/gateway` (+ `package.json`), `npm i`, run `npm run gateway` (use pm2/systemd, put it behind TLS or restrict by firewall to your home IP).
3. **Local:** `docker compose up -d` (migrations in `packages/db/migrations` auto-apply on first start).
4. `npm install && npm test` runs the trophy-rule/season tests and an integration test (embedded Postgres via pglite) covering the schema, ingest, dedupe, queue and coverage view.
5. Start the workers: `pm2 start ecosystem.config.cjs` (see `docs/processes.md`).

## First live validations (do these on the first captured season)
- `attackerTrophies/defenderTrophies` vs the raw `atk_log_reported` / `def_log_reported` columns (which side does the `trophies` field describe?).
- `reconcile()` per fully-fetched player: residual vs expected missing-defense bonus.
- Season id = unix start time? Promotion rates vs `player_season_result`.

## Validation after the first captured season
`npm run validate` rebuilds the derived tables and prints: which side the log's `trophies` field describes, trophy reconciliation (residual vs the missing-defense bonus), observed promotion shares vs the configured rates, the season-id check, and coverage.
