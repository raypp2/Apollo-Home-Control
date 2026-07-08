/**
 * Apollo Home Control Bridge - MQTT Command Listener
 * @module mqttCommandListener.js
 *
 * @description  Stage 10 of the MQTT plan (issue #23). Subscribes to AWS IoT
 *               classic-shadow delta topics (`$aws/things/+/shadow/update/delta`,
 *               forwarded inbound by the Mosquitto <-> IoT Core bridge) and, for
 *               every statefulMqtt Alexa endpoint, translates the delta's
 *               `desired` fields into the exact same `/MODULE/DEVICE/COMMAND/PARAM`
 *               command strings the Alexa Lambda already sends over SQS today --
 *               see buildBasePath()/buildFieldPath() below, which mirror
 *               handlePowerOrLight() in the sibling Apollo-Alexa-Skill repo's
 *               handleDevices.mjs line for line.
 *
 *               Apollo NEVER writes shadow `desired` state -- only the Lambda
 *               does, on a command directive. Apollo's own `reported` writes
 *               (mqttTopics.js's publishShadowIfStateful) are what eventually
 *               clears the delta once the command takes effect.
 *
 *               Parallel-run instrumentation (issue #23): the COMMAND_SOURCE env
 *               var ('sqs' default | 'shadow') controls whether this listener
 *               actually executes commands or only logs a SHADOW-CMD comparison
 *               line, and (inversely) whether sqsListener.js executes or only
 *               logs SQS-CMD. Both paths always receive every command during the
 *               parallel-run validation period; only one of them actually calls
 *               handleRequest() at a time. See sample.env for the switch.
 *
 *               TESTING NOTE: like the other Stage 3+ listener modules, this
 *               module's dependencies (mqttClient.subscribe, the parsed
 *               config/triggers.json array, the injected handleRequest, and the
 *               COMMAND_SOURCE mode) are lazily resolved on first real use via
 *               ensureInit(), so merely requiring this file never boots
 *               index.js, reads triggers.json, or touches the broker. Tests call
 *               `_init({ subscribe, triggers, handleRequest, commandSource })`
 *               with fixtures/spies first, then exercise `_handleDelta(topic,
 *               payload)` directly -- mirroring lightingShelly.test.js's
 *               "call the handler directly, don't re-test mqttClient's own
 *               topic-matching dispatch" approach.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const TRIGGERS_PATH = path.join(__dirname, '..', 'config', 'triggers.json');
const DELTA_TOPIC_FILTER = '$aws/things/+/shadow/update/delta';
const THING_PREFIX = 'apollo-';

// Order commands execute in when a single delta carries more than one field --
// power first, matching the Lambda sending one SQS message per directive (one
// directive = one field), replayed here in a stable order.
const FIELD_ORDER = ['power', 'brightness', 'position'];

let doSubscribe;
let doHandleRequest;
let triggersByEndpointId = new Map();
let commandSourceMode = 'sqs';
let initialized = false;

// Shadow-delta dedupe (CRITICAL, see module doc): deltas re-fire on every
// reported update while desired remains divergent (e.g. an unreachable
// device) -- without this, one stuck desired field would re-execute a command
// on every poll sweep. Keyed by full thing name (e.g. "apollo-kitchenLight").
const lastVersionByThing = new Map();

// Logged once per endpoint (not per message) -- see logUnknownEndpointOnce().
const loggedUnknownEndpoints = new Set();

/**
 * Builds an endpointId -> trigger Map from a parsed triggers.json array.
 * @param {Array} triggers
 * @returns {Map<string, object>}
 */
function buildIndex(triggers) {
    const map = new Map();
    for (const trigger of triggers || []) {
        if (trigger && trigger.endpointId) {
            map.set(trigger.endpointId, trigger);
        }
    }
    return map;
}

/**
 * Reads and parses config/triggers.json once. This is the file
 * src/alexaTriggers.js writes at startup (before this module's first real
 * use, per index.js's require order) -- read lazily via fs+JSON.parse rather
 * than watching for changes, since triggers.json only changes when Apollo
 * itself restarts (which re-requires this module fresh anyway).
 * @returns {Map<string, object>}
 */
function loadTriggersFromDisk() {
    try {
        const raw = fs.readFileSync(TRIGGERS_PATH, 'utf8');
        return buildIndex(JSON.parse(raw));
    } catch (err) {
        console.log('MQTT command listener: failed to read config/triggers.json: %s', err && err.message);
        return new Map();
    }
}

/**
 * Reads the COMMAND_SOURCE env var once. Defaults to 'sqs' -- the safe
 * default during the parallel-run validation period (issue #23): SQS keeps
 * executing commands, shadow deltas are log-only until the latency/reliability
 * comparison is confirmed.
 * @returns {"sqs"|"shadow"}
 */
function readCommandSourceFromEnv() {
    return process.env.COMMAND_SOURCE === 'shadow' ? 'shadow' : 'sqs';
}

/**
 * Lazily wires this module to the real mqttClient + triggers.json the first
 * time it's actually needed. See the module doc comment for why this is lazy
 * rather than top-level requires/reads.
 */
function ensureInit() {
    if (initialized) {
        return;
    }
    const mqttClient = require('./mqttClient');
    doSubscribe = mqttClient.subscribe;
    triggersByEndpointId = loadTriggersFromDisk();
    commandSourceMode = readCommandSourceFromEnv();
    console.log(
        'MQTT command listener: COMMAND_SOURCE=%s (%s)',
        commandSourceMode,
        commandSourceMode === 'shadow'
            ? 'shadow deltas execute commands; SQS is log-only'
            : 'SQS executes commands; shadow deltas are log-only comparison'
    );
    initialized = true;
}

/**
 * Test-only (and otherwise unused in production) override hook. See the
 * module doc comment above for why this exists.
 * @param {object} deps
 * @param {function} deps.subscribe - (topicFilter, handler) => void
 * @param {Array} deps.triggers - fixture triggers.json array
 * @param {function} deps.handleRequest - spy/fake, called with a command path string
 * @param {"sqs"|"shadow"} [deps.commandSource] - defaults to 'sqs'
 */
function _init({ subscribe, triggers, handleRequest, commandSource } = {}) {
    doSubscribe = subscribe || (() => {});
    triggersByEndpointId = buildIndex(triggers || []);
    doHandleRequest = handleRequest || (() => {});
    commandSourceMode = commandSource || 'sqs';
    lastVersionByThing.clear();
    loggedUnknownEndpoints.clear();
    initialized = true;
}

/**
 * Called from index.js with handleRequest injected (mirrors how
 * lightingInsteonListener.js's startListener() takes handleRequest) -- this
 * module never requires('./handler') itself, avoiding any load-order
 * dependency on when handler.js finishes requiring '../index'.
 * @param {function} handleRequest - handler.js's handleRequest(path)
 */
function startCommandListener(handleRequest) {
    ensureInit();
    doHandleRequest = handleRequest;
    doSubscribe(DELTA_TOPIC_FILTER, _handleDelta);
}

/**
 * Logs an unresolved/non-stateful endpoint exactly once, not once per delta
 * (shadow deltas can re-fire repeatedly while desired/reported stay
 * divergent -- see the dedupe comment above).
 * @param {string} endpointId
 * @param {string} thing
 */
function logUnknownEndpointOnce(endpointId, thing) {
    if (loggedUnknownEndpoints.has(endpointId)) {
        return;
    }
    loggedUnknownEndpoints.add(endpointId);
    console.log(
        'MQTT command listener: unknown or non-stateful endpoint "%s" (thing %s) -- ignoring shadow delta',
        endpointId,
        thing
    );
}

/**
 * Builds the `/MODULE/DEVICE[/apiCommand]` prefix shared by every command for
 * this trigger, mirroring handlePowerOrLight()'s
 * `` `/${apiModule}/${apiDevice}` `` + `` if (trigger.apiCommand) { apiCommand
 * += `/${trigger.apiCommand}` } `` in Apollo-Alexa-Skill/handleDevices.mjs.
 * @param {object} trigger
 * @returns {string}
 */
function buildBasePath(trigger) {
    let base = `/${trigger.apiModule}/${trigger.apiDevice}`;
    if (trigger.apiCommand) {
        base += `/${trigger.apiCommand}`;
    }
    return base;
}

/**
 * Builds the full command path for a single delta field, mirroring
 * handlePowerOrLight() exactly:
 *   - power:      devCommand = "on"/"off" (lowercase, per the Lambda's
 *                 TurnOn/TurnOff cases) -- always appended.
 *   - brightness/position: percentageState = the numeric value, appended via
 *                 `if (percentageState) { apiCommand += ... }`. NOTE this
 *                 reproduces the Lambda's existing falsy-zero quirk: a value
 *                 of exactly 0 is falsy in JS, so the Lambda's SQS path does
 *                 NOT append it either -- mirrored here deliberately rather
 *                 than "fixed", since Stage 10's parallel-run validation
 *                 depends on both paths behaving identically for the same
 *                 directive. (Flagged as a pre-existing Lambda-side quirk,
 *                 not something to invent new behavior around here.)
 * Returns null (and logs once) for a malformed field value -- never throws.
 * @param {object} trigger
 * @param {"power"|"brightness"|"position"} field
 * @param {*} value
 * @returns {string|null}
 */
function buildFieldPath(trigger, field, value) {
    const base = buildBasePath(trigger);

    if (field === 'power') {
        if (value !== 'ON' && value !== 'OFF') {
            console.log('MQTT command listener: malformed power value for %s: %s', trigger.endpointId, JSON.stringify(value));
            return null;
        }
        return `${base}/${value === 'ON' ? 'on' : 'off'}`;
    }

    // brightness / position: numeric 0-100, per mqtt-implementation-plan.md's
    // shadow field conventions.
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
        console.log('MQTT command listener: malformed %s value for %s: %s', field, trigger.endpointId, JSON.stringify(value));
        return null;
    }

    // Mirrors the Lambda's `if (percentageState)` -- see doc comment above.
    if (!value) {
        return base;
    }
    return `${base}/${value}`;
}

/**
 * Builds the ordered list of command path strings for every recognized field
 * present in a delta's `state` object (power first, then brightness, then
 * position -- FIELD_ORDER). Unrecognized fields are ignored silently (the
 * shadow state shape may grow fields this listener doesn't act on yet, e.g.
 * `color`).
 * @param {object} trigger
 * @param {object} state
 * @returns {string[]}
 */
function buildCommands(trigger, state) {
    const paths = [];
    for (const field of FIELD_ORDER) {
        if (!Object.prototype.hasOwnProperty.call(state, field)) {
            continue;
        }
        const commandPath = buildFieldPath(trigger, field, state[field]);
        if (commandPath) {
            paths.push(commandPath);
        }
    }
    return paths;
}

/**
 * Handler for `$aws/things/+/shadow/update/delta`. Never throws -- every
 * failure mode (malformed payload, unknown endpoint, a handleRequest throw)
 * is caught, logged, and dropped. See the module doc comment for the overall
 * flow: thing -> endpointId -> trigger lookup -> version dedupe -> command
 * path(s) -> COMMAND_SOURCE-gated execution + comparison logging.
 * @param {string} topic
 * @param {*} payload
 */
function _handleDelta(topic, payload) {
    try {
        handleDeltaInner(topic, payload);
    } catch (err) {
        console.log('MQTT command listener: error handling delta on %s: %s', topic, err && err.message);
    }
}

function handleDeltaInner(topic, payload) {
    const parts = topic.split('/');
    // $aws/things/<thing>/shadow/update/delta -- thing is segment index 2.
    const thing = parts.length >= 3 ? parts[2] : null;
    if (!thing || !thing.startsWith(THING_PREFIX)) {
        return; // not one of ours
    }
    const endpointId = thing.slice(THING_PREFIX.length);

    if (
        !payload ||
        typeof payload !== 'object' ||
        !payload.state ||
        typeof payload.state !== 'object' ||
        !Number.isFinite(payload.version)
    ) {
        console.log('MQTT command listener: malformed delta payload on %s: %s', topic, JSON.stringify(payload));
        return;
    }

    const trigger = triggersByEndpointId.get(endpointId);
    if (!trigger || trigger.statefulMqtt !== true) {
        logUnknownEndpointOnce(endpointId, thing);
        return;
    }

    // Version dedupe (CRITICAL -- see module-level comment on
    // lastVersionByThing): a delta with version <= last processed for this
    // thing is ignored silently, no log -- this is the expected, frequent
    // case while a desired field stays stuck divergent (e.g. device
    // unreachable), not an error.
    const lastVersion = lastVersionByThing.get(thing);
    if (lastVersion !== undefined && payload.version <= lastVersion) {
        return;
    }
    lastVersionByThing.set(thing, payload.version);

    const commands = buildCommands(trigger, payload.state);

    const latencyMs = Number.isFinite(payload.timestamp) ? (Date.now() - payload.timestamp * 1000) : 'n/a';
    const label = commandSourceMode === 'shadow' ? 'SHADOW-CMD' : 'SHADOW-CMD (log-only)';
    console.log(
        '%s: %s %s version=%s latency=%sms',
        label,
        endpointId,
        JSON.stringify(payload.state),
        payload.version,
        latencyMs
    );

    if (commandSourceMode !== 'shadow') {
        return; // sqs mode: comparison log only, never execute
    }

    for (const commandPath of commands) {
        try {
            doHandleRequest(commandPath);
        } catch (err) {
            console.log('MQTT command listener: handleRequest threw for %s: %s', commandPath, err && err.message);
        }
    }
}

module.exports = {
    startCommandListener,
    _init,
    _handleDelta,
};
