// Configuration for pm2 process manager
// Host-agnostic: paths resolve relative to this file's location.

module.exports = {
  apps: [{
    name: "Apollo",
    script: "./index.js",
    cwd: __dirname,
    log_file:   "./public/logs/apollo.log",
    error_file: "./public/logs/err.log",
    out_file:   "./public/logs/out.log"
  }]
}
