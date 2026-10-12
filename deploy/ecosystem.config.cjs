// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("node:path");
const appRoot = process.env.PLANNER_APP_ROOT || process.cwd();

module.exports = {
  apps: [
    {
      name: process.env.PM2_APP_NAME || "clickup-planner",
      cwd: appRoot,
      script: path.join(appRoot, "server.js"),
      interpreter: process.execPath,
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      min_uptime: "10s",
      restart_delay: 5000,
      max_memory_restart: "512M",
      watch: false,
    },
  ],
};
