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
 *               canonical MQTT state for both event-sourced (hub 'command' broadcasts) and
 *               poll-sourced updates.
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
 *               interaction added here (event handling, polling) is wrapped so a
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
let hub = new Insteon();

var config = {
  host: process.env.INSTEON_HUB_IP,
  port: 25105,
  user: process.env.INSTEON_USERNAME,
  password: process.env.INSTEON_PASSWORD
};

//### Variables for outbound-command coordination (staggered polling)
// Shared with lightingInsteon.js via noteCommandSent() -- the hub has a small
// command buffer, so an outbound device/scene command and the poll sweep must
// never overlap. See startInsteonPolling() below for the pause window.
let lastCommandAt = 0;

/**
 * Called by lightingInsteon.js whenever an outbound Insteon command is sent
 * (device or scene). Used to pause the poll sweep so it never contends with
 * the hub's small command buffer right after a real command went out.
 */
function noteCommandSent() {
  lastCommandAt = Date.now();
}

/**
 * Exposes the same hub connection used by the poll sweep so lightingInsteon.js
 * can schedule its post-command verification poll without opening a second
 * connection to the hub.
 * @returns {object} the home-controller Insteon hub instance
 */
function getHub() {
  return hub;
}

/**
 * Test-only hook: swaps in a fake hub (e.g. `{ light: () => ({ level: () =>
 * Promise.resolve(...) }) }`) so pollTick()/getHub() can be exercised without
 * a real home-controller connection. Never called from production code.
 * @param {object} fakeHub
 */
function _setHub(fakeHub) {
  hub = fakeHub;
}


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

    // Staggered round-robin polling (Stage 3). Only starts once the hub has
    // actually connected, so it never runs against a failed connection.
    startInsteonPolling();
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
 * Physical broadcasts and how each maps to state:
 *   11 ON        -> {power ON}, ramp-to level unknown -> follow-up poll
 *   12 FAST-ON   -> {power ON, brightness 100} (full by definition)
 *   13 OFF       -> {power OFF, brightness 0}
 *   14 FAST-OFF  -> {power OFF, brightness 0}
 *   17 START MANUAL CHANGE -> ignored (nothing settled yet)
 *   18 STOP MANUAL CHANGE  -> no publish; follow-up poll reads the settled
 *                             level (hold-to-dim releases land here)
 * See scheduleEventFollowUpPoll() for the poll mechanics.
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

    // Command coverage (live-debug finding, 2026-07-07): a physical HOLD-to-dim
    // broadcasts START (0x17) / STOP (0x18) MANUAL CHANGE -- not 11/13 -- and a
    // double-tap broadcasts FAST-ON (0x12) / FAST-OFF (0x14). Handling only
    // 11/13 left hold-dims silent until the round-robin sweep wandered past
    // (up to ~90s of stale state in the Alexa app / dashboard).
    if (command1 === '18') {
        // Manual dim finished at paddle release; the resulting level (possibly
        // 0) is unknowable from the broadcast -- the follow-up poll publishes
        // the settled truth on its own. '17' (start) is deliberately ignored.
        const entry = findLightByAddress(commandId);
        if (entry) {
            scheduleEventFollowUpPoll(entry, commandId);
        }
        return;
    }

    let power;
    let brightness;
    let followUp = false;
    if (command1 === '11') {
        power = 'ON';
        followUp = true; // ramp-to level unknown -- poll for it
    } else if (command1 === '12') {
        power = 'ON';
        brightness = 100; // FAST-ON is full brightness by definition
    } else if (command1 === '13' || command1 === '14') {
        power = 'OFF';
        brightness = 0; // OFF/FAST-OFF are definitionally 0
    } else {
        return; // Ignore silently -- not a state-bearing broadcast (e.g. '17').
    }

    const entry = findLightByAddress(commandId);
    if (!entry) {
        return;
    }

    const state = (brightness === undefined) ? { power } : { power, brightness };
    mqttTopics.publishState(entry, state, 'event');
    entry.checked = (power === 'ON');
    entry.status = (brightness !== undefined) ? brightness : 100;
    if (followUp) {
        scheduleEventFollowUpPoll(entry, commandId);
    }
}

/*
############# EVENT FOLLOW-UP POLL (physical ON events)

A physical switch ON press ramps to whatever level the switch has locally
stored -- the hub's broadcast event doesn't carry it, so the optimistic
{power: 'ON'} published above leaves the dashboard's dim value stale. This
schedules a single one-shot level() poll shortly after, mirroring
lightingInsteon.js's verifyDeviceState() but simpler: this is a read (never
calls noteCommandSent()) and a failure is just dropped -- the round-robin
sweep will catch up on its own, so this never engages pollPausedUntil.
*/

let EVENT_FOLLOWUP_POLL_DELAY_MS = 3000;

// Dedupe (issue #31-style burst re-emission): the hub re-emits the same
// physical event several times in a quick burst. Without this, each
// re-emission would schedule its own follow-up poll. Keyed by uppercased hex
// address; a timer stays in this map from scheduling until it fires (or is
// cleared by _resetPollStateForTesting) so a burst only ever schedules one.
let pendingEventFollowUpPolls = new Map(); // commandId -> Timeout

/**
 * Test-only hook: shrinks the event follow-up poll delay (e.g. to 50ms) so
 * tests can exercise it with a real, short setTimeout instead of waiting out
 * the real 3000ms delay. Never called from production code.
 * @param {number} ms
 */
function _setEventFollowUpPollDelayForTesting(ms) {
    EVENT_FOLLOWUP_POLL_DELAY_MS = ms;
}

/**
 * Schedules a single one-shot level() poll for `entry` unless one is already
 * pending for the same address -- a burst of identical ON events (the hub
 * re-emits) must only ever schedule one follow-up poll.
 * @param {object} entry - the lights.json entry to poll
 * @param {string} commandId - uppercased hex address, used as the dedupe key
 */
function scheduleEventFollowUpPoll(entry, commandId) {
    if (pendingEventFollowUpPolls.has(commandId)) {
        return; // already have a follow-up poll pending for this device
    }

    const timer = setTimeout(function () {
        pendingEventFollowUpPolls.delete(commandId);
        runEventFollowUpPoll(entry);
    }, EVENT_FOLLOWUP_POLL_DELAY_MS);

    if (typeof timer.unref === 'function') {
        timer.unref();
    }

    pendingEventFollowUpPolls.set(commandId, timer);
}

/**
 * Polls the device's actual level via the hub and publishes the polled truth,
 * mirroring pollTick()'s payload shape. Never throws and never triggers an
 * unhandled rejection -- a failure here is simply dropped (logged once); the
 * round-robin sweep will correct the stale brightness on its own, so this
 * deliberately does not engage pollPausedUntil/handlePollError's 60s backoff.
 * @param {object} entry
 */
function runEventFollowUpPoll(entry) {
    let result;
    try {
        result = hub.light(entry.address).level();
    } catch (err) {
        console.log('Insteon event follow-up poll error: %s', err && err.message);
        return;
    }

    Promise.resolve(result).then(function (lvl) {
        const level = (typeof lvl === 'number') ? lvl : 0;
        const power = level > 0 ? 'ON' : 'OFF';

        mqttTopics.publishState(entry, { power, brightness: level }, 'poll');
        entry.checked = (power === 'ON');
        entry.status = level;
    }).catch(function (err) {
        console.log('Insteon event follow-up poll error: %s', err && err.message);
    });
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
############# INSTEON MODULE FOR STAGGERED POLLING

Bulk-polling every device at once (the old, disabled insteon_setup_devices())
overflows the 2245 hub's small command buffer -- that is why it was disabled.
Instead, round-robin ONE device every 5s so a full sweep of a dozen lights
takes about a minute, and never contend with an outbound command (see
lastCommandAt / noteCommandSent above).
*/

const POLL_INTERVAL_MS = 5000;
const COMMAND_QUIET_MS = 10000; // pause polling for this long after any outbound command
const POLL_ERROR_BACKOFF_MS = 60000;

let pollRotationIndex = 0;
let pollTimer = null;
let pollInFlight = false; // true while a .level() call is outstanding -- prevents a hung poll from stacking
let pollPausedUntil = 0; // hub-outage backoff (Date.now() timestamp)
let loggedPollError = false; // log a poll failure once per outage, not once per subsequent tick

/**
 * Returns the list of insteon-type lights eligible for round-robin polling.
 * Recomputed each tick (cheap; `lights_new` is a small array) so the rotation
 * naturally adapts if config were ever reloaded.
 * @returns {Array}
 */
function insteonLights() {
    return lights_new.filter((entry) => entry.type === 'insteon' && entry.address);
}

/**
 * Test-only hook: resets all module-level poll scheduling state (rotation
 * index, in-flight flag, error backoff window/flag, lastCommandAt, and any
 * pending event follow-up poll timers) so tests don't leak state into each
 * other. Never called from production code.
 */
function _resetPollStateForTesting() {
    pollRotationIndex = 0;
    pollInFlight = false;
    pollPausedUntil = 0;
    loggedPollError = false;
    lastCommandAt = 0;

    for (const timer of pendingEventFollowUpPolls.values()) {
        clearTimeout(timer);
    }
    pendingEventFollowUpPolls.clear();
}

/**
 * One round-robin polling tick: polls a single insteon light's level via the
 * hub, publishes poll-sourced canonical state, and syncs the in-memory entry.
 * Skips (without advancing the rotation) if:
 *  - polling is currently paused due to a recent outbound command, or a prior
 *    hub-error backoff window, or
 *  - the previous poll call hasn't settled yet (never stack concurrent polls).
 */
function pollTick() {
    ensureInit();

    const targets = insteonLights();
    if (targets.length === 0) {
        return;
    }

    if (Date.now() < pollPausedUntil) {
        return; // hub-outage backoff still in effect
    }

    if (Date.now() - lastCommandAt < COMMAND_QUIET_MS) {
        return; // an outbound command just used the hub's buffer -- don't contend with it
    }

    if (pollInFlight) {
        return; // previous poll hasn't settled -- never stack concurrent hub calls
    }

    if (pollRotationIndex >= targets.length) {
        pollRotationIndex = 0;
    }
    const entry = targets[pollRotationIndex];
    pollRotationIndex = (pollRotationIndex + 1) % targets.length;

    pollInFlight = true;

    let result;
    try {
        result = hub.light(entry.address).level();
    } catch (err) {
        pollInFlight = false;
        handlePollError(err);
        return;
    }

    Promise.resolve(result).then(function (lvl) {
        pollInFlight = false;
        loggedPollError = false;

        const level = (typeof lvl === 'number') ? lvl : 0;
        const power = level > 0 ? 'ON' : 'OFF';

        mqttTopics.publishState(entry, { power, brightness: level }, 'poll');
        entry.checked = (power === 'ON');
        entry.status = level;
    }).catch(function (err) {
        pollInFlight = false;
        handlePollError(err);
    });
}

/**
 * Logs a poll failure exactly once per outage (not per subsequent tick) and
 * sets a 60s pause on all polling -- hub-outage backoff, per the risk note
 * about home-controller's hub connection being a historic crash source.
 * @param {Error} err
 */
function handlePollError(err) {
    if (!loggedPollError) {
        loggedPollError = true;
        console.log('Insteon poll error: %s -- pausing polling for %dms', err && err.message, POLL_ERROR_BACKOFF_MS);
    }
    pollPausedUntil = Date.now() + POLL_ERROR_BACKOFF_MS;
}

/**
 * Starts the staggered round-robin poll sweep. Called from startListener()
 * after the hub connects, so it never runs against a failed connection. Safe
 * to call more than once (e.g. in tests) -- clears any prior timer first.
 */
function startInsteonPolling() {
    if (pollTimer) {
        clearInterval(pollTimer);
    }
    pollTimer = setInterval(pollTick, POLL_INTERVAL_MS);
    if (typeof pollTimer.unref === 'function') {
        pollTimer.unref();
    }
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
    noteCommandSent,
    getHub,
    _handleHubCommand,
    isKeypadPress,
    pollTick,
    startInsteonPolling,
    _init,
    _setHub,
    _resetPollStateForTesting,
    _setKeypadDedupeWindowForTesting,
    _resetKeypadStateForTesting,
    _setEventFollowUpPollDelayForTesting,
    };
