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
// Publishes the desired-field clear (see clearDesiredFields() below). Wired
// to the real mqttClient.publish in ensureInit(), same as doSubscribe;
// defaults to a no-op so requiring this module never touches the broker, and
// so tests that don't care about the clear (most of the existing suite)
// aren't perturbed. Injectable via _init()'s `publish` dep.
let doPublish = () => {};
let triggersByEndpointId = new Map();
let commandSourceMode = 'sqs';
let initialized = false;
// Separate from `initialized` -- see loadTriggersIfNeeded()/loadTriggersFromDisk()
// below. `initialized` gates the one-time subscribe + COMMAND_SOURCE log;
// this gates only whether the triggers.json load succeeded, so a failed
// first read (e.g. a startup race with alexaTriggers.js's write) gets
// retried on the next delta instead of being cached as a permanently empty
// index.
let triggersLoaded = false;
// Function pointer so tests can substitute a controllable fake in place of
// the real fs.readFileSync(TRIGGERS_PATH) read -- see _init()'s `diskLoader`
// param and loadTriggersIfNeeded() below. Defaults to the real
// loadTriggersFromDisk() (function declarations hoist, so this is valid even
// though loadTriggersFromDisk is defined later in the file).
let doLoadTriggersFromDisk = loadTriggersFromDisk;

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
 *
 * Returns `null` on any read/parse failure rather than an empty Map -- the
 * caller (loadTriggersIfNeeded()) uses that distinction to decide whether the
 * load succeeded (even a legitimately empty array is success) or must be
 * retried later. Swallowing a failure into an empty-but-"successful" Map is
 * exactly the bug this is fixing: a transient failure (e.g. a startup race
 * with alexaTriggers.js's write) would otherwise get cached forever as "zero
 * endpoints known".
 * @returns {Map<string, object>|null}
 */
function loadTriggersFromDisk() {
    try {
        const raw = fs.readFileSync(TRIGGERS_PATH, 'utf8');
        return buildIndex(JSON.parse(raw));
    } catch (err) {
        console.log('MQTT command listener: failed to read config/triggers.json: %s', err && err.message);
        return null;
    }
}

/**
 * Attempts the triggers.json load if (and only if) it hasn't already
 * succeeded. Safe to call on every delta -- once `triggersLoaded` is true
 * this is a no-op, so a healthy listener never re-reads the file per
 * message. Called both from ensureInit() (the startup attempt) and from
 * handleDeltaInner() (the retry-on-first-use-after-a-failed-startup-read
 * path), so a delta arriving after startup -- by which point triggers.json
 * is guaranteed complete, since alexaTriggers.js now writes it synchronously
 * -- recovers cleanly even if the very first read raced and failed.
 */
function loadTriggersIfNeeded() {
    if (triggersLoaded) {
        return;
    }
    const index = doLoadTriggersFromDisk();
    if (index) {
        triggersByEndpointId = index;
        triggersLoaded = true;
    }
    // On failure, leave triggersByEndpointId as-is (empty, or whatever was
    // last successfully loaded) and triggersLoaded false -- the next call
    // (next delta) will retry.
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
 *
 * The subscribe + COMMAND_SOURCE read + startup log are genuinely one-time
 * and stay gated by `initialized`. The triggers.json load is delegated to
 * loadTriggersIfNeeded(), which is guarded separately by `triggersLoaded` --
 * see that function's doc comment for why: a failed read here must not
 * prevent a later retry once the file is actually complete.
 */
function ensureInit() {
    if (initialized) {
        return;
    }
    const mqttClient = require('./mqttClient');
    doSubscribe = mqttClient.subscribe;
    doPublish = mqttClient.publish;
    loadTriggersIfNeeded();
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
 *
 * Normal mode (no `diskLoader`): fully replaces state with the injected
 * fixtures/spies and marks both `initialized` and `triggersLoaded` true, so
 * a subsequent ensureInit() call is a no-op -- this is what every existing
 * test in this file relies on (no real subscribe, no real disk read, no
 * COMMAND_SOURCE log).
 *
 * `diskLoader` mode: for the one test (the triggers-load retry regression
 * test) that needs to exercise the REAL ensureInit()/loadTriggersIfNeeded()
 * path -- including the one-time subscribe + COMMAND_SOURCE log and the
 * retry-on-failure behavior -- rather than short-circuiting it. Leaves
 * `initialized`/`triggersLoaded` false and swaps `doLoadTriggersFromDisk` for
 * the injected fake, so a following `startCommandListener(handleRequest)`
 * call runs ensureInit() for real, and later deltas' loadTriggersIfNeeded()
 * calls the injected loader (and retries it) instead of trusting canned
 * triggers.
 * @param {object} deps
 * @param {function} [deps.subscribe] - (topicFilter, handler) => void
 * @param {Array} [deps.triggers] - fixture triggers.json array
 * @param {function} [deps.handleRequest] - spy/fake, called with a command path string
 * @param {function} [deps.publish] - spy/fake, called with (topic, payload, opts)
 *   to assert the desired-clear publish; see clearDesiredFields() below.
 *   Defaults to a no-op, matching doPublish's own default.
 * @param {"sqs"|"shadow"} [deps.commandSource] - defaults to 'sqs'
 * @param {function(): (Map|null)} [deps.diskLoader] - replaces the real
 *   triggers.json read; see "diskLoader mode" above
 */
function _init({ subscribe, triggers, handleRequest, publish, commandSource, diskLoader } = {}) {
    doHandleRequest = handleRequest || (() => {});
    doPublish = publish || (() => {});
    lastVersionByThing.clear();
    loggedUnknownEndpoints.clear();

    if (diskLoader) {
        doSubscribe = subscribe || (() => {});
        doLoadTriggersFromDisk = diskLoader;
        triggersByEndpointId = new Map();
        triggersLoaded = false;
        initialized = false;
        return;
    }

    doSubscribe = subscribe || (() => {});
    doLoadTriggersFromDisk = loadTriggersFromDisk;
    triggersByEndpointId = buildIndex(triggers || []);
    triggersLoaded = true; // injected triggers count as a successful load -- no disk retry needed
    commandSourceMode = commandSource || 'sqs';
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
 * Returns the FIELD_ORDER fields present in a delta's `state` object -- i.e.
 * the fields this listener actually looked at and acted on (whether or not
 * buildFieldPath() produced a valid command path for them; see
 * clearDesiredFields() below for why a malformed value is cleared too, not
 * just a successfully-executed one). Unrecognized fields (e.g. `color`) are
 * excluded deliberately -- this listener hasn't acted on them, so it must not
 * claim/clear them out of `desired`.
 * @param {object} state
 * @returns {string[]}
 */
function recognizedFieldsPresent(state) {
    return FIELD_ORDER.filter((field) => Object.prototype.hasOwnProperty.call(state, field));
}

/**
 * Empties the "desired inbox" for exactly the fields this delta carried and
 * this listener processed, once the command has been satisfied -- see the
 * module doc comment's parallel-run context and issue #23 for the underlying
 * bug this fixes: AWS IoT shadow `desired` is a sticky setpoint, not a
 * transient command queue. Apollo's `reported` writes (mqttTopics.js) clear
 * the delta ONLY while `desired` still matches what was just reported; a
 * later, unrelated reported change (e.g. "turn off" after "set brightness
 * 50") leaves the old `desired.brightness` permanently diverged from
 * `reported.brightness`, and IoT re-emits a `delta` on every subsequent
 * reported update forever (confirmed live in issue #23's parallel-run logs).
 * Nulling a shadow desired key deletes it (AWS IoT shadow semantics), which
 * is exactly the fix: once a field's desired value is gone, there's nothing
 * left to diverge from reported, so IoT stops emitting deltas for it.
 *
 * Publishes to `.../shadow/update` (a plain state-report topic), NOT
 * `.../shadow/update/delta` (the topic this module SUBSCRIBES to) -- so this
 * publish can never loop back into `_handleDelta` itself, regardless of what
 * IoT does with it. And per AWS IoT shadow semantics, deleting/rescinding a
 * desired field does not itself produce a new delta (there's no new desired
 * value to diff against reported) -- so even downstream, this clear cannot
 * trigger a fresh inbound delta that would drive this function again.
 *
 * Called in BOTH COMMAND_SOURCE modes: in `sqs` mode, sqsListener.js is the
 * one actually executing the command, but this listener still received and
 * logged the same delta, and the whole point of the parallel run is to keep
 * the shadow clean in both modes so the eventual flip to `shadow` mode is
 * safe and the comparison logs stay uncluttered.
 *
 * Never throws -- a publish failure (offline broker, or in tests, an
 * injected throwing `doPublish`) is caught and logged here so it can never
 * escape the delta handler; the command was already received/acted on, so a
 * failed cleanup publish must not be treated as a failed command.
 * @param {string} thing - e.g. "apollo-kitchenLight" (topic segment 2)
 * @param {string[]} fields - recognizedFieldsPresent(payload.state)
 */
function clearDesiredFields(thing, fields) {
    if (!fields.length) {
        return;
    }
    try {
        const desired = {};
        for (const field of fields) {
            desired[field] = null;
        }
        doPublish(`$aws/things/${thing}/shadow/update`, { state: { desired } }, { qos: 1, retain: false });
    } catch (err) {
        console.log('MQTT command listener: failed to clear desired fields for %s: %s', thing, err && err.message);
    }
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

    // Retry a previously-failed triggers.json load before resolving the
    // endpoint -- a no-op once the load has succeeded. This is what makes a
    // startup-time read failure recoverable: any delta arriving after
    // startup (by which point triggers.json is guaranteed complete, since
    // alexaTriggers.js writes it synchronously) gets a fresh chance to
    // populate triggersByEndpointId instead of being stuck against the
    // empty index from a failed first read.
    loadTriggersIfNeeded();

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
    const fieldsToClear = recognizedFieldsPresent(payload.state);

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
        // sqs mode: comparison log only, never execute -- but sqsListener.js
        // IS executing this same command right now, so the desired inbox
        // still needs clearing (see clearDesiredFields() doc comment).
        clearDesiredFields(thing, fieldsToClear);
        return;
    }

    // Execute first, clear desired after -- see clearDesiredFields() doc
    // comment: if execution threw and we'd already cleared desired, the
    // command would be silently lost (IoT would never re-deliver it, since
    // nothing would diverge). Each iteration is already wrapped so a single
    // command's failure can't skip the rest, or skip the clear below.
    for (const commandPath of commands) {
        try {
            doHandleRequest(commandPath);
        } catch (err) {
            console.log('MQTT command listener: handleRequest threw for %s: %s', commandPath, err && err.message);
        }
    }

    clearDesiredFields(thing, fieldsToClear);
}

module.exports = {
    startCommandListener,
    _init,
    _handleDelta,
};
