[Overview](../README.md) &nbsp;&nbsp;&nbsp;|&nbsp;&nbsp;&nbsp; <u>🧭 Installation</u> &nbsp;&nbsp;&nbsp;|&nbsp;&nbsp;&nbsp; [🛠️ Maintenance](./maintenance.md) &nbsp;&nbsp;&nbsp;|&nbsp;&nbsp;&nbsp; [🔮 Roadmap](./roadmap.md)

# Installation

## Prepare System

1) Start with a linux disto 
   I use: BeagleBone Black ([setup instructions](./beaglebone.md))

2) Install Packages:
	- Node JS 20.x
	- [Forever](https://www.npmjs.com/package/forever) 4.x
	
>**My permanent system**
Beaglebone Black
Debian GNU/Linux 11.7 (bullseye)
Node v20.8.0
Forever 4.0.3

>**Developed & tested on**
Mac OS Sonoma 14.0
Node v20.8.0

## Setup Apollo Controller App

1) Clone this repository and run `npm install`:

```bash
cd ~
git clone https://github.com/raypp2/Apollo-Home-Control.git
mv Apollo-Home-Control apollo_home_control
cd apollo_home_control
npm install
```

2) Allow node application to use port 80

```bash
sudo setcap 'cap_net_bind_service=+ep' $(which node)
```

3) Test application
```bash
node index.js
```

## Configuration

To use this application, you'll need to set up your credentials in a `.env` file. See the included `.env.example` file for an example of how to format your credentials.

Similarly, you will need to setup the config files that are in the config folder including:

- `devices.json`
- `deviceScenes.json`
- `insteonKeypad.json` (if applicable)
- `lightingScenes.json`
- `lights.json`
- `macros.json`

Samples and sytax are provided in this repo. Note that triggers.json is automatically generated. 


## Setup Daemon Process Manager (recommended)

Start application in PM2

```bash
npm install pm2@latest -g
pm2 start ecosystem.config.js
```

Setup pm2.io: Monitoring & Diagnostic Web Interface
```bash
pm2 plus
```

Configure to run on startup
```bash
pm2 startup
pm2 save
```


## Setup Log Rotation 

The forever application will create log files that must be pruned or they will fill up the limited memory on the microcontroller.

Create a logrotate configuration file:

```bash
sudo nano /etc/logrotate.d/apollo
```

Paste config

```
/home/debian/apollo_home_control/public/logs/*.log {
    weekly
    rotate 4
    size 10M
    compress
    missingok
    notifempty
    create 0644 debian debian
}
```

| Attribute | Description |
| --- | ----------- |
| weekly | Rotate logs weekly |
| rotate 4 | Keep 4 weeks of logs (30 days) |
| size 10M | Limit each log file to 10MB |
| compress | Compress old log files |
| missingok | Don't generate an error if the log file is missing |
| notifempty | Don't rotate if the log file is empty |
| create 0644 debian debian | Set permissions and ownership for new log files |




## Install Homebridge (optional)

Homebridge allows inregration with Apple Homekit. It allows a quick and easy way of accessing devices while I am not connected to my home network. I use this for door lock controls so I can buzz the door when I arrive home and before I'm connected to my home network. Apple uses my AppleTV as a smart home hub for this. 

1) [Follow instructions to install](https://github.com/homebridge/homebridge/wiki/Install-Homebridge-on-Debian-or-Ubuntu-Linux)
2) Install plugins Homebridge Http Switch - homebridge-http-switch v0.5.36 by @supereg
3) Install config.json backup
4) Restart and test

Application service will start on boot automatically.