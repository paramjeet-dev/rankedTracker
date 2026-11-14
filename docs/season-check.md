# Checking stored seasons and freeing the queue

```powershell
npm run seasons               # per-season coverage, stored rows, remaining queue, time left
npm run seasons -- --check    # + battles vs roster counters for members with final logs
npm run trim-queue            # dry run: counts per rule
npm run trim-queue -- --keep-weeks 2 --apply
```
`REPORT_RATE=150 npm run seasons` changes the calls/s used for the runtime estimate (PowerShell: `$env:REPORT_RATE=150; npm run seasons`).

What is stored per season: `league_group` (group tags, tier, roster time), `group_member` (name, clan, final trophies, W/L counters, log flags), `battle` (one row per battle with stars, destruction, computed gains),
`player_season` (tier, trophies, placement, W/L per player), derived `trophy_timeline` / `player_season_stats` / `player_hour_hist` / `group_stats` (aggregator), and `data/raw` (every response, pruned after RAW_RETENTION_DAYS).

Manual psql (Docker): `docker compose exec db psql -U coc -d coc`, then e.g.
```sql
select * from coverage_by_season order by season_id desc;        -- slow view (scans group_member per group)
select kind, status, count(*) from job group by 1, 2 order by 1, 2;
```
