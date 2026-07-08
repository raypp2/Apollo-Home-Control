/**
 * Apollo Home Control Bridge
 * 
 * @author Ray Perfetti
 * @date 2021-10-08
 * @version 5.0
 * 
 * @description     Centralize control of home devices via:
 *                  - An HTTP based API endpoint
 *                  - Retrieve commands from an Amazon SQS Queue
 *                  - An HTML front-end
 * 
 *                  Supported Devices
 *                  -  Insteon Dimmers, Plug-In Modules, & Keypads
 *                  -  GlobalCache iTach controllers for serial, IR, & Contact Closure devices
 *                  -  IP conrol devices
 *                  -  Amazon Alexa voice control via SQS queue
 *                  -  Spotify login & transfer playback
 *                  -  Find-My-iPhone ping
 *                  -  Forever for fallback & logging
 *                  -  Phillips Hue
 * 
 */

// Load environment variables from .env file
require('dotenv').config(); 

// HTTP Module for sending device commands
global.http = require('http');

const fs = require('fs');                                       // Load the File System module
const devicesJSON           = './config/devices.json';          // Load Devices
const deviceScenesJSON      = './config/deviceScenes.json';     // Load Device Scenes
const lightsJSON            = './config/lights.json';           // Load Lights
const lightingScenesJSON    = './config/lightingScenes.json';   // Load Lighting Scenes
const macrosJSON            = './config/macros.json';           // Load Macros
const insteonKeypadJSON     = './config/insteonKeypad.json';    // Load Insteon Keypad

// Load Devices using JSON5 to allow for comments
const JSON5             = require('json5');
const devices           = JSON5.parse(fs.readFileSync(devicesJSON, 'utf8'));
const deviceScenes      = JSON5.parse(fs.readFileSync(deviceScenesJSON, 'utf8'));
const lights            = JSON5.parse(fs.readFileSync(lightsJSON, 'utf8'));
const lightingScenes    = JSON5.parse(fs.readFileSync(lightingScenesJSON, 'utf8'));
const macros            = JSON5.parse(fs.readFileSync(macrosJSON, 'utf8'));
const insteonKeypad     = JSON5.parse(fs.readFileSync(insteonKeypadJSON, 'utf8'));


// For debug tracking
let logging = {           
    operation_num: 0,
};

module.exports = {
    devices,
    deviceScenes,
    lights,
    lightingScenes,
    macros,
    insteonKeypad,
    logging
}

// Connect to the MQTT broker first -- non-blocking, safe even if the broker
// is down. Other modules require this freely since it never requires('../index').
const mqttClient = require('./src/mqttClient');
mqttClient.connect();

// Orphan MQTT retained-state topic cleanup (live-incident hardening fix) --
// sweeps apollo/+/+/+/state for retained topics that no longer correspond to
// any configured light/device (e.g. removed from lights.json/devices.json)
// and clears them so healthMonitor.js doesn't seed a permanent ghost
// stale/degraded entry from their retained replay. Runs once per process
// lifetime; safe in both dry-run and live mode since it only touches local
// MQTT broker retained-message bookkeeping, not hardware. Fire-and-forget --
// doesn't block any other startup step below. See src/mqttOrphanCleanup.js.
require('./src/mqttOrphanCleanup').cleanupOrphanedStateTopics().catch((err) => {
    console.log('Orphan topic cleanup: unexpected rejection: %s', err && err.message);
});

// Orchestration Handlers
const { handleRequest }
= require('./src/handler.js');

// Subscribe to Shelly devices' native MQTT status/LWT topics and republish
// canonical state (Stage 2 of the MQTT plan). Requires mqttTopics.js, which
// pulls in config via require('../index') -- must load after this module has
// exported its config above, same rule as every other src/ module.
const { startShellyListener } = require('./src/lightingShelly.js');
startShellyListener();

// Subscribe to the ESPSomfy-RTS bridge's native MQTT per-shade position
// topics and republish canonical state (Stage 2 of the MQTT plan). Same
// load-order rule as above -- requires mqttTopics.js.
const { startSomfyListener } = require('./src/somfyBridge.js');
startSomfyListener();

// Rebuild Alexa Triggers Config File
const alexa = require('./src/alexaTriggers');
alexa.buildTriggers();

// Start Web & API Servers
const webServer = require('./src/webServer');
webServer.startServer();

const DRY_RUN = process.env.APOLLO_DRY_RUN === '1';

if (DRY_RUN) {
    // Skip requiring sqsListener entirely -- it has a module-level env check that
    // calls process.exit(1) if AWS env vars aren't set, so a conditional require
    // (not just skipping startListener()) is needed here.
    console.log("###### APOLLO_DRY_RUN=1 -- SQS Listener NOT started (dry-run) ######");
    console.log("###### APOLLO_DRY_RUN=1 -- Insteon Listener NOT started (dry-run) ######");
    console.log("###### APOLLO_DRY_RUN=1 -- Hue SSE Listener NOT started (dry-run) ######");
    console.log("###### APOLLO_DRY_RUN=1 -- IP device power poller NOT started (dry-run) ######");
    console.log("###### APOLLO_DRY_RUN=1 -- MQTT Command Listener NOT started (dry-run) ######");
    console.log("###### APOLLO_DRY_RUN=1 -- MQTT Set Listener NOT started (dry-run) ######");
} else {
    // Start SQS Listener
    const sqsListener = require('./src/sqsListener');
    sqsListener.startListener();

    // Start Insteon Listener for KeyPad Presses
    const insteonListener = require('./src/lightingInsteonListener');
    insteonListener.startListener(handleRequest);

    // Start MQTT Command Listener (Stage 10 of the MQTT plan, issue #23) --
    // subscribes to IoT shadow deltas for Alexa commands, running in parallel
    // with the SQS listener above during the validation period. See
    // src/mqttCommandListener.js and the COMMAND_SOURCE env var (sample.env).
    const mqttCommandListener = require('./src/mqttCommandListener');
    mqttCommandListener.startCommandListener(handleRequest);

    // Start MQTT Set Listener (Stage 6 of the MQTT plan, issue #14) --
    // subscribes to apollo/+/+/+/set, the generic command topic
    // homebridge-mqttthing publishes to when a HomeKit accessory is
    // controlled, and routes it through the same handleRequest() path as
    // every other command source. Independent of the SQS/shadow
    // COMMAND_SOURCE switch above -- HomeKit is its own command channel, not
    // part of the Alexa parallel-run comparison. See src/mqttSetListener.js.
    const mqttSetListener = require('./src/mqttSetListener');
    mqttSetListener.startSetListener(handleRequest);

    // Start Philips Hue SSE Listener (Stage 4 of the MQTT plan, issue #12) --
    // subscribes to the Hue bridge's own event stream for near-real-time
    // state publishing, with a v1 HTTP fallback poll while disconnected.
    // Gated the same way as the Insteon listener above: it holds an open
    // connection to real hardware, so it's skipped in dry-run.
    const hueListener = require('./src/lightingPhilipsHueListener');
    hueListener.startListener();

    // Periodic power-state poll for ip_control devices (Stage 5 of the MQTT
    // plan, issue #13) -- publishes source:'poll' power state every 60s
    // through the same persistent connection commands use, so the dashboard
    // has real projector/receiver state between commands. No-ops on its own
    // if ITACH_PERSISTENT_CONNECTIONS=false; gated here the same as the other
    // listeners above since it holds open connections to real hardware.
    const tcpServers = require('./src/tcpServers');
    tcpServers.startIpPowerPoller();
}

// Health monitor (Stage 8, issue #20) -- last startup step since it observes
// everything else (all state topics + bridge status topics published above).
// Read-only: runs in dry-run too, since it never sends device commands.
require('./src/healthMonitor').start();

// Spotify now-playing publisher (Stage 9, issue #22) -- opt-in via
// SPOTIFY_NOW_PLAYING=1 since it costs a Spotify API call every 10s around
// the clock; not worth running until Stage 11 puts a now-playing card on the
// dashboard. Also skipped in dry-run, same as the other outbound pollers.
if (process.env.SPOTIFY_NOW_PLAYING === '1' && !DRY_RUN) {
    const { startNowPlayingPublisher } = require('./src/spotify');
    startNowPlayingPublisher();
    console.log('###### SPOTIFY_NOW_PLAYING=1 -- now-playing publisher started ######');
}

// Catch unhandled errors to prevent a single ecosystem failure from crashing the entire bridge
process.on('uncaughtException', function(err) {
    console.log('Uncaught exception: %s', err.message);
});

process.on('unhandledRejection', function(reason) {
    console.log('Unhandled rejection: %s', reason);
});