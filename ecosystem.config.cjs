// pm2: one process per workload, independently startable/stoppable. `pm2 start ecosystem.config.cjs`
const app = (name) => ({ name, script: "node", args: `--env-file=.env --import tsx apps/${name}/src/index.ts`, autorestart: true, restart_delay: 5000 });
module.exports = { apps: ["availability", "scheduler", "seeds", "profile", "history", "roster", "memberlog", "aggregator"].map(app) };
