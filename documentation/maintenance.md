[Overview](../README.md) &nbsp;&nbsp;&nbsp;|&nbsp;&nbsp;&nbsp; [🧭 Installation](./installation.md) &nbsp;&nbsp;&nbsp;|&nbsp;&nbsp;&nbsp; <u>🛠️ Maintenance</u> &nbsp;&nbsp;&nbsp;|&nbsp;&nbsp;&nbsp; [🔮 Roadmap](./roadmap.md)

# Maintenance

## Useful Terminal Commands

Restart the server

```bash
shutdown -r now
```

## PM2

PM2 is a daemon process manager that ensures our applications run continuously by restarting the applications when they crash and logging console outputs to files that are accessed via the web server for bugging of issues when they occur.

Usage:

```bash
pm2 start ecosystem.config.js 
pm2 ls
pm2 stop all
pm2 restart all
pm2 restart 1
```

## Homebridge

http://beaglebone.local:8581

Useful Commands:

```bash
systemctl status homebridge
sudo systemctl start homebridge
sudo systemctl enable homebridge
journalctl -f -u homebridge
```