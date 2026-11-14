# Moving Postgres from Docker to a native Windows install

Why: Docker Desktop runs Postgres inside a WSL2 VM that keeps a large slice of RAM, plus every query crosses a port-forward. A native Postgres uses only what it is configured to and is faster per query.
Everything below runs on the PC. Keep the Docker volume until the checks in step 7 pass.

## 1. Stop ingestion
Ctrl+C each worker (graceful drain), then kill leftovers (`Get-Process node | Stop-Process`). In-flight jobs go back to the queue after 10 min (`requeueStale`).

## 2. Dump inside the container (PowerShell `>` corrupts binary, so never redirect)
```powershell
docker compose exec db pg_dump -U coc -d coc -Fd -j 4 -f /tmp/cocdump
docker compose cp db:/tmp/cocdump D:\pgdump
docker compose stop db          # frees port 5432; do NOT run `down -v` yet
```
Directory format is compressed and restores in parallel.

## 3. Install PostgreSQL 16 (same major version as the container)
EDB installer or `winget install PostgreSQL.PostgreSQL.16`. Put the data directory on the SSD with the free space (e.g. `D:\pgdata`). Keep `listen_addresses = '127.0.0.1'`.

## 4. Role, database, restore
```powershell
psql -U postgres -c "create role coc login password 'coc'"
createdb -U postgres -O coc coc
pg_restore -U postgres -d coc -j 4 --no-owner --role=coc D:\pgdump
vacuumdb -U postgres -d coc --analyze-only -j 4     # a restore carries no planner statistics
```

## 5. Settings for 16 GB shared with ~9 Node processes (edit `postgresql.conf` in the data dir, restart the service)
```
shared_buffers = 2GB
effective_cache_size = 6GB
work_mem = 32MB
maintenance_work_mem = 1GB
max_wal_size = 8GB
checkpoint_timeout = 15min
checkpoint_completion_target = 0.9
wal_compression = on
synchronous_commit = off        # a crash can lose the last moments; jobs just re-run and every write is idempotent
max_connections = 200           # each worker pool is PG_POOL (default 12)
random_page_cost = 1.1          # SSD
autovacuum_vacuum_cost_limit = 2000
```
```sql
alter table job set (autovacuum_vacuum_scale_factor = 0.02, autovacuum_vacuum_cost_delay = 0);  -- the queue deletes a row per finished job
```
Optional: exclude the data directory from Windows Defender real-time scanning (it slows Postgres noticeably; it is a security trade-off).

## 6. Apply the new migration and backfill (workers still stopped)
```powershell
npm run migrate                # baselines 001-004, applies 005 (job.season_id + index, player_season.source)
npm run backfill:job-season    # fills job.season_id for queued roster/memberlog rows (index-range scan per 200k ids)
```
`.env`: `DATABASE_URL=postgres://coc:coc@127.0.0.1:5432/coc` (127.0.0.1, not localhost).

## 7. Verify, then start workers
`npm run status` should show the same job/player/battle counts as the handoff. Run a worker for a few minutes, then:
```powershell
docker compose down -v         # only now; this deletes the old volume
wsl --shutdown                 # releases the VM's RAM; also turn off "Start Docker Desktop when you sign in"
```
`docker-compose.yml` stays for tests/dev only.

## Archive plan (not built yet)
A season that has left the API window can no longer receive writes. Export its `battle_<season>` partition and `group_member` rows to Parquet (zstd) with DuckDB, check row counts, detach and drop the partition, and query the files with DuckDB. Aggregates for the dashboard stay in Postgres/SQLite.
