// Configuration for pm2 process manager

module.exports = {
  apps : [{
    name: "Apollo",
    script: "./index.js",
    cwd: "/home/debian/apollo_home_control",
    log_file: "/home/debian/apollo_home_control/public/logs/apollo.log",
    error_file: "/home/debian/apollo_home_control/public/logs/err.log",
    out_file: "/home/debian/apollo_home_control/public/logs/out.log"
  }]
}