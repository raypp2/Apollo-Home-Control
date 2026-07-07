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
} else {
    // Start SQS Listener
    const sqsListener = require('./src/sqsListener');
    sqsListener.startListener();

    // Start Insteon Listener for KeyPad Presses
    const insteonListener = require('./src/lightingInsteonListener');
    insteonListener.startListener(handleRequest);
}

// Health monitor (Stage 8, issue #20) -- last startup step since it observes
// everything else (all state topics + bridge status topics published above).
// Read-only: runs in dry-run too, since it never sends device commands.
require('./src/healthMonitor').start();

// Catch unhandled errors to prevent a single ecosystem failure from crashing the entire bridge
process.on('uncaughtException', function(err) {
    console.log('Uncaught exception: %s', err.message);
});

process.on('unhandledRejection', function(reason) {
    console.log('Unhandled rejection: %s', reason);
});