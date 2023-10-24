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

// Orchestration Handlers
const { handleRequest }                                   
= require('./src/handler.js');

// Rebuild Alexa Triggers Config File
const alexa = require('./src/alexaTriggers');
alexa.buildTriggers();

// Start Web & API Servers
const webServer = require('./src/webServer');
webServer.startServer(); 

// Start SQS Listener
const sqsListener = require('./src/sqsListener');  
sqsListener.startListener();

// Start Insteon Listener for KeyPad Presses
const insteonListener = require('./src/lightingInsteonListener');
insteonListener.startListener(handleRequest);