[Overview](../README.md) &nbsp;&nbsp;&nbsp;|&nbsp;&nbsp;&nbsp; [🧭 Installation](./installation.md) &nbsp;&nbsp;&nbsp;|&nbsp;&nbsp;&nbsp; <u>🛠️ Maintenance</u> &nbsp;&nbsp;&nbsp;|&nbsp;&nbsp;&nbsp; [🔮 Roadmap](./roadmap.md)

# Maintenance

## Useful Terminal Commands

Restart the server

    shutdown -r now

Manually start bridge

    node apollo_home_control_v5.0.js



## Forever

A node.js program that ensures our applications runs continuously by restarting the applications when they crash and logging console outputs to files that are accessed via the web server for bugging of issues when they occur.

Usage:

    forever start apollo_forever.json 
    forever list
    forever stopall
    forever restartall
    forever restart 1

## Homebridge

http://beaglebone.local:8581

Useful Commands:

    systemctl status homebridge
    systemctl status homebridge
    sudo systemctl start homebridge
    sudo systemctl enable homebridge
    journalctl -f -u homebridge