# Scheduled work

The reference repo has a scheduler because its work depends on calendar windows. Here the one calendar rule, "a
season can be collected 10 minutes after it ends", is a condition in the `battles` target query, and the weekly
profile refresh is a condition in the `players-profile` target query. Both survive restarts by construction, so no
separate scheduler process is needed.

What remains outside the processes: run `retention-probe` (existing script) after each rollover if you want to keep
measuring how long the API serves old groups.

Calendar rule everywhere: season id = start time, Monday 05:00 UTC, length 7 days (`SEASON_SECONDS`).
