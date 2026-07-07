/**
 * Apollo Home Control Bridge - Insteon Listener Module
 * @module lightingInsteonListener.js
 *
 * @author Ray Perfetti
 * @date 2023-10-08
 *
 * @description  Monitors the status of devices on Insteon.
 *               This status polling is used to update the status of the device in the UI,
 *               and (per documentation/mqtt-implementation-detail.md Stage 3) publishes
 *               canonical MQTT state for event-sourced hub 'command' broadcasts.
 *
 *               KeyPad Linc Features
 *               Responds to a Keypad Linc button press by executing a command.
 *               Feedback can be provided to the user by blinking the button twice.
 *
 *               Dependencies:
 *               - Insteon Hub (tested with 2245-222)
 *               - home-controller by Automate Green (Brandon Goode)
 *                       https://github.com/automategreen/home-controller
 *
 *               Risk note (issue #2, closed): the `home-controller` package's hub
 *               connection has historically been a crash source. Every new hub
 *               interaction added here (event handling) is wrapped so a
 *               throw can never escape and take down the process or the existing
 *               keypad-press dispatch.
 *
 *               TESTING NOTE: like mqttTopics.js, this module's config
 *               dependencies (`lights_new`, `insteon_keypad`) are lazily pulled
 *               from '../index' on first real use (ensureInit()), so merely
 *               requiring this file in a test does not boot index.js (which
 *               reads config/*.json and starts servers as a side effect).
 *               Tests call `_init({ lights, insteonKeypad })` with fixture
 *               arrays first, exactly like mqttTopics.test.js. Production code
 *               paths never call `_init`.
 */

'use strict';

const mqttTopics = require('./mqttTopics');

let lights_new;
let insteon_keypad;
let initialized = false;

/**
 * Lazily wires this module to the real Apollo config the first time it's
 * actually needed. See the module doc comment for why this is lazy rather
 * than a top-level require('../index').
 */
function ensureInit() {
    if (initialized) {
        return;
    }
    const index = require('../index');
    lights_new = index.lights;
    insteon_keypad = index.insteonKeypad;
    initialized = true;
}

/**
 * Test-only (and otherwise unused in production) override hook. See the
 * module doc comment above for why this exists.
 * @param {object} deps
 * @param {Array} deps.lights
 * @param {Array} deps.insteonKeypad
 */
function _init({ lights: lightsOverride, insteonKeypad: keypadOverride }) {
    lights_new = lightsOverride;
    insteon_keypad = keypadOverride;
    initialized = true;
}


//### Variables for Keypress Watcher
// Time-windowed dedupe (issue #31): the Insteon hub re-emits the same button
// event several times in a quick burst. We only want to suppress genuine
// repeats within that burst, not forever -- a second, deliberate press of the
// same button minutes later must still work. `let`, not `const`, only so
// tests can shrink the window (see _setKeypadDedupeWindowForTesting) instead
// of sleeping 3s in a unit test.
let KEYPAD_DEDUPE_WINDOW_MS = 3000;
var last_command = null; // { command, at }

/**
 * Test-only hook: shrinks the keypad dedupe window (e.g. to 50ms) so tests
 * can exercise the "within window" vs "after window" behavior with real,
 * short setTimeouts instead of waiting out the real 3000ms window. Never
 * called from production code.
 * @param {number} ms
 */
function _setKeypadDedupeWindowForTesting(ms) {
  KEYPAD_DEDUPE_WINDOW_MS = ms;
}

/**
 * Test-only hook: clears the last-run keypad command so tests don't leak
 * dedupe state into each other. Never called from production code.
 */
function _resetKeypadStateForTesting() {
  last_command = null;
}

var Insteon = require('home-controller').Insteon;
var hub = new Insteon();

var config = {
  host: process.env.INSTEON_HUB_IP,
  port: 25105,
  user: process.env.INSTEON_USERNAME,
  password: process.env.INSTEON_PASSWORD
};


function startListener(handleRequest) {

    ensureInit();

    hub.on('error', function(err){
        console.log('Insteon hub error: %s', err.message);
    });

    hub.httpClient(config, function(){
    console.log('Insteon listener connected!');

    hub.emitOnAck = false;

    hub.on('command', function(info){
        // console.log("Command Observed:",info);
        if (info !== undefined){
        if (info.standard !== undefined){
        if (info.standard.id !== undefined){
        isKeypadPress(info,handleRequest);
        }}}

        // MQTT event publishing (Stage 3, issue #11). Wrapped separately and
        // defensively so a throw here can never break isKeypadPress above,
        // which must keep working exactly as it did before this stage.
        try {
            _handleHubCommand(info);
        } catch (err) {
            console.log('Insteon MQTT event handling error: %s', err.message);
        }
    });

    // insteon_setup_devices();  // Polls and creates listeners for devices to keep status updated on interfaces
    // holding until web interface is fixed.
    // Might create issues with Keypad watchers
    // Replaced by the staggered round-robin poll sweep in a later commit.
    });

}

/**
 * Given a hub 'command' event, if it matches a configured insteon light's
 * address (case-insensitive hex compare) and is a plain ON (11) or OFF (13),
 * publishes canonical MQTT state and syncs the in-memory entry the same way
 * lighting.js does for locally-originated commands. Any other command1 value
 * is ignored silently -- dimming/brighten/etc are not (yet) mapped to a
 * canonical state here.
 *
 * Exported as a pure-ish function (only side effect is via injected/module
 * lights_new + mqttTopics) for direct unit testing, mirroring lightingShelly's
 * `_handle*` test-instrumentation pattern.
 * @param {object} info - the home-controller 'command' event payload
 */
function _handleHubCommand(info) {
    ensureInit();

    if (!info || !info.standard || !info.standard.id) {
        return;
    }

    const commandId = String(info.standard.id).toUpperCase();
    const command1 = info.standard.command1;

    let power;
    if (command1 === '11') {
        power = 'ON';
    } else if (command1 === '13') {
        power = 'OFF';
    } else {
        return; // Ignore silently -- not a plain ON/OFF we map to state.
    }

    const entry = findLightByAddress(commandId);
    if (!entry) {
        return;
    }

    mqttTopics.publishState(entry, { power }, 'event');

    entry.checked = (power === 'ON');
    entry.status = (power === 'ON') ? 100 : 0;
}

/**
 * Looks up a lights.json entry of type "insteon" by its hex address, matched
 * case-insensitively (the hub reports addresses in whatever case it likes;
 * config addresses are typed by hand and may differ in case).
 * @param {string} address - uppercased hex address
 * @returns {object|null}
 */
function findLightByAddress(address) {
    for (const entry of lights_new) {
        if (entry.type === 'insteon' && entry.address && entry.address.toUpperCase() === address) {
            return entry;
        }
    }
    return null;
}


/*
############# INSTEON MODULE FOR RECEIVING BUTTON COMMANDS

*/

function isKeypadPress(info,handleRequest) {
  ensureInit();

  var commandDevice =   info.standard.id           || false;
  var commandGateway  = info.standard.gatewayId    || false;
  var commandCommand1 = info.standard.command1     || false;
  var commandCommand2 = info.standard.command2     || false;

  for(var i = 0;i < insteon_keypad.length; i++){
    if(insteon_keypad[i].device_id==commandDevice){
      // console.log("X - Observed a command from devices #%d @ %s to gateway %s",i,commandDevice,commandGateway);
      // console.log("Command Observed:",info);
      var testGateways    = insteon_keypad[i].gateways || false;

      for(var z = 0;z<testGateways.length;z++){
          (function (p) {
            if(testGateways[p].id==commandGateway){
                var commandName = testGateways[p].name;
                // console.log("X - This is a watched gateway #%d %s",p,commandName);

                // Load the ON or OFF commands
                if (commandCommand1=="11" && commandCommand2=="00"){
                    var runCommand = testGateways[p].command_on;
                } else if(commandCommand1=="13" && commandCommand2=="00"){
                    var runCommand = testGateways[p].command_off;
                }

                // Test for duplicate within the dedupe window (issue #31): the hub
                // re-emits the same event several times in a quick burst, but a
                // second, deliberate press of the same button later must still work.
                const now = Date.now();
                if (last_command && last_command.command === runCommand && (now - last_command.at) < KEYPAD_DEDUPE_WINDOW_MS) {
                  // console.log("X - Disregarding because action was recently run: %s",runCommand);
                } else {
                  console.log("X - Running %s", runCommand);
                  handleRequest("/"+runCommand);

                  last_command = { command: runCommand, at: now };
                }
            }
          }) (z)
      }
    }
  }
}

module.exports = {
    startListener,
    _handleHubCommand,
    isKeypadPress,
    _init,
    _setKeypadDedupeWindowForTesting,
    _resetKeypadStateForTesting,
    };
