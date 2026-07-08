/**
 * Apollo Home Control Bridge - MQTT Set (Command) Listener
 * @module mqttSetListener.js
 *
 * @description  Stage 6 of the MQTT plan (issue #14). Subscribes to
 *               `apollo/+/+/+/set` -- the generic command topic
 *               homebridge-mqttthing publishes to when a HomeKit accessory is
 *               controlled -- and translates each `/set` payload into the
 *               exact same `/MODULE/DEVICE/COMMAND/PARAM` command strings the
 *               web UI/SQS/Insteon-keypad paths already send to
 *               handler.js's handleRequest(). This is the "MQTT as a command
 *               bus" half of the plan; mqttTopics.js's publishState() /
 *               lightingShelly.js / somfyBridge.js etc. already cover the
 *               "state" half.
 *
 *               Unlike mqttCommandListener.js (Stage 10, AWS IoT shadow
 *               deltas for Alexa), this listener resolves a config entry by
 *               its canonical MQTT topic (via mqttTopics.js's findByTopic --
 *               `.../set` -> `.../state` -> config entry), not by an
 *               endpointId/trigger lookup, and it is NEVER gated by
 *               COMMAND_SOURCE: that switch only exists to compare the SQS
 *               and shadow-delta paths for the *same* Alexa-origin commands
 *               during Stage 10's validation period. HomeKit is a completely
 *               independent command channel, so this listener always
 *               executes.
 *
 *               Retained messages are ignored (see handleSetInner() below):
 *               a `/set` topic is a one-shot command, not state, so replaying
 *               the last-retained command at every broker
 *               reconnect/subscribe would re-fire it. mqttClient.js's
 *               subscribe() handler signature was extended with a fourth
 *               `retain` arg for exactly this (see its module doc comment).
 *
 *               TESTING NOTE: like the other Stage 3+ listener modules, this
 *               module's dependencies (mqttClient.subscribe,
 *               mqttTopics.findByTopic, and the injected handleRequest) are
 *               lazily resolved on first real use via ensureInit(), so merely
 *               requiring this file never boots index.js or touches the
 *               broker. Tests call `_init({ subscribe, findByTopic,
 *               handleRequest })` with fixtures/spies first, then exercise
 *               `_handleSet(topic, payload, raw, retain)` directly --
 *               mirroring lightingShelly.test.js's "call the handler
 *               directly, don't re-test mqttClient's own topic-matching
 *               dispatch" approach.
 */

'use strict';

const SET_TOPIC_FILTER = 'apollo/+/+/+/set';
const SET_SUFFIX = '/set';
const STATE_SUFFIX = '/state';

// Order commands execute in when a single payload carries more than one
// recognized field -- power first, so e.g. {"power":"ON","brightness":40}
// turns a light on and then dims it, not the reverse.
const FIELD_ORDER = ['power', 'brightness', 'position'];

// Config `type` values controlled through /LIGHTS/<id>/... paths.
const LIGHT_TYPES = new Set(['insteon', 'hue-group', 'shelly', 'wled', 'dmxFixture']);

// Config `type` value controlled through /DEVICES/<id>/all/... paths.
const SOMFY_TYPE = 'Somfy-Bridge';

let doSubscribe;
let doFindByTopic;
let doHandleRequest;
let initialized = false;

// Logged once per topic (not per message) -- a mis-provisioned/decommissioned
// HomeKit accessory would otherwise flood apollo.log on every command.
const loggedUnknownTopics = new Set();

// Logged once per entry+field combo -- e.g. a `position` sent for a light,
// or `brightness` sent for a shade, is a HomeKit/config mismatch worth
// knowing about, but not on every single command.
const loggedUnsupportedFields = new Set();

/**
 * Lazily wires this module to the real mqttClient + mqttTopics the first
 * time it's actually needed. See the module doc comment for why this is lazy
 * rather than top-level requires.
 */
function ensureInit() {
    if (initialized) {
        return;
    }
    const mqttClient = require('./mqttClient');
    const mqttTopics = require('./mqttTopics');
    doSubscribe = mqttClient.subscribe;
    doFindByTopic = mqttTopics.findByTopic;
    initialized = true;
}

/**
 * Test-only (and otherwise unused in production) override hook. See the
 * module doc comment above for why this exists.
 * @param {object} deps
 * @param {function} [deps.subscribe] - (topicFilter, handler) => void
 * @param {function} [deps.findByTopic] - (stateTopic) => entry|null
 * @param {function} [deps.handleRequest] - spy/fake, called with a command path string
 */
function _init({ subscribe, findByTopic, handleRequest } = {}) {
    doSubscribe = subscribe || (() => {});
    doFindByTopic = findByTopic || (() => null);
    doHandleRequest = handleRequest || (() => {});
    loggedUnknownTopics.clear();
    loggedUnsupportedFields.clear();
    initialized = true;
}

/**
 * Called from index.js with handleRequest injected (mirrors
 * mqttCommandListener.js's startCommandListener() and
 * lightingInsteonListener.js's startListener()) -- this module never
 * requires('./handler') itself, avoiding any load-order dependency on when
 * handler.js finishes requiring '../index'.
 * @param {function} handleRequest - handler.js's handleRequest(path)
 */
function startSetListener(handleRequest) {
    ensureInit();
    doHandleRequest = handleRequest;
    doSubscribe(SET_TOPIC_FILTER, _handleSet);
}

/**
 * Logs an unresolved `/set` topic exactly once, not once per command.
 * @param {string} topic
 */
function logUnknownTopicOnce(topic) {
    if (loggedUnknownTopics.has(topic)) {
        return;
    }
    loggedUnknownTopics.add(topic);
    console.log('MQTT set listener: unknown topic "%s" (no matching config entry) -- ignoring', topic);
}

/**
 * Logs a field that doesn't apply to this entry's type exactly once per
 * entry+field combo (e.g. `position` sent for a light).
 * @param {object} entry
 * @param {string} field
 */
function logUnsupportedFieldOnce(entry, field) {
    const key = `${entry.id}:${field}`;
    if (loggedUnsupportedFields.has(key)) {
        return;
    }
    loggedUnsupportedFields.add(key);
    console.log(
        'MQTT set listener: field "%s" does not apply to entry "%s" (type %s) -- skipping',
        field,
        entry.id,
        entry.type
    );
}

/**
 * Parses a raw `/set` payload into a plain object carrying at least one
 * recognized field, or returns null for anything else (non-JSON, non-object,
 * array, or an object with no recognized field). Payloads arriving through
 * mqttClient.js are usually already JSON.parse'd objects (see its 'message'
 * handler); a defensive JSON.parse is also attempted for a raw string, so
 * this function works whether it's fed mqttClient's parsed payload or a
 * plain string directly (e.g. from a test).
 * @param {*} payload
 * @returns {object|null}
 */
function parsePayload(payload) {
    let obj = payload;

    if (typeof obj === 'string') {
        try {
            obj = JSON.parse(obj);
        } catch {
            return null;
        }
    }

    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
        return null;
    }

    const hasRecognizedField = FIELD_ORDER.some((field) => Object.prototype.hasOwnProperty.call(obj, field));
    return hasRecognizedField ? obj : null;
}

/**
 * Builds the command path for a single recognized field, or returns null
 * (logging once) if the field doesn't apply to this entry's type or carries
 * a malformed value. Never throws.
 * @param {object} entry
 * @param {"power"|"brightness"|"position"} field
 * @param {*} value
 * @returns {string|null}
 */
function buildFieldPath(entry, field, value) {
    const isLight = LIGHT_TYPES.has(entry.type);
    const isSomfy = entry.type === SOMFY_TYPE;

    if (field === 'power') {
        if (value !== 'ON' && value !== 'OFF') {
            console.log('MQTT set listener: malformed power value for %s: %s', entry.id, JSON.stringify(value));
            return null;
        }
        const command = value === 'ON' ? 'on' : 'off';
        if (isLight) {
            return `/LIGHTS/${entry.id}/${command}`;
        }
        if (isSomfy) {
            return `/DEVICES/${entry.id}/all/${command}`;
        }
        logUnsupportedFieldOnce(entry, field);
        return null;
    }

    // brightness / position: numeric 0-100.
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
        console.log('MQTT set listener: malformed %s value for %s: %s', field, entry.id, JSON.stringify(value));
        return null;
    }

    if (field === 'brightness') {
        if (!isLight) {
            logUnsupportedFieldOnce(entry, field);
            return null;
        }
        return `/LIGHTS/${entry.id}/${value}`;
    }

    // field === 'position'
    if (!isSomfy) {
        logUnsupportedFieldOnce(entry, field);
        return null;
    }
    return `/DEVICES/${entry.id}/all/${value}`;
}

/**
 * Builds the ordered list of command path strings for every recognized field
 * present in a parsed `/set` payload (power first -- FIELD_ORDER).
 * Unrecognized fields are ignored silently (the payload shape may grow
 * fields this listener doesn't act on yet).
 * @param {object} entry
 * @param {object} state
 * @returns {string[]}
 */
function buildCommands(entry, state) {
    const paths = [];
    for (const field of FIELD_ORDER) {
        if (!Object.prototype.hasOwnProperty.call(state, field)) {
            continue;
        }
        const commandPath = buildFieldPath(entry, field, state[field]);
        if (commandPath) {
            paths.push(commandPath);
        }
    }
    return paths;
}

/**
 * Handler for `apollo/+/+/+/set`. Never throws -- every failure mode
 * (retained replay, unknown topic, malformed payload, a handleRequest throw)
 * is caught, logged (where useful), and dropped.
 * @param {string} topic
 * @param {*} payload
 * @param {Buffer} [raw]
 * @param {boolean} [retain]
 */
function _handleSet(topic, payload, raw, retain) {
    try {
        handleSetInner(topic, payload, retain);
    } catch (err) {
        console.log('MQTT set listener: error handling set on %s: %s', topic, err && err.message);
    }
}

function handleSetInner(topic, payload, retain) {
    // A retained `/set` message is a replay of the last command (delivered
    // on subscribe or broker reconnect), not a fresh one -- see the module
    // doc comment. Must never re-fire a physical command.
    if (retain) {
        return;
    }

    if (typeof topic !== 'string' || !topic.endsWith(SET_SUFFIX)) {
        return; // shouldn't happen given the subscription filter, but defensive
    }
    const stateTopic = topic.slice(0, -SET_SUFFIX.length) + STATE_SUFFIX;

    const entry = doFindByTopic(stateTopic);
    if (!entry) {
        logUnknownTopicOnce(topic);
        return;
    }

    const state = parsePayload(payload);
    if (!state) {
        console.log('MQTT set listener: malformed or empty payload on %s: %s', topic, JSON.stringify(payload));
        return;
    }

    const commands = buildCommands(entry, state);
    for (const commandPath of commands) {
        try {
            doHandleRequest(commandPath);
        } catch (err) {
            console.log('MQTT set listener: handleRequest threw for %s: %s', commandPath, err && err.message);
        }
    }
}

module.exports = {
    startSetListener,
    _init,
    _handleSet,
};
