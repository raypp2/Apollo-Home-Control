/**
 * Apollo Home Control Bridge - Scene Shadow State
 * @module sceneShadow.js
 *
 * @description  Dashboard redesign, increment 3 (documentation/dashboard-redesign-plan.md
 *               §4.2). Scenes (`config/lightingScenes.json`) and macros
 *               (`config/macros.json`) are opaque hub-side handles -- Apollo
 *               fires "activate insteon group 12" / "run hue scene <guid>"
 *               and the PLM or Hue bridge sets member devices to levels
 *               programmed in the hardware. The config never enumerates which
 *               devices a scene touches or to what level, so there is no
 *               static membership map to read.
 *
 *               Apollo is the only thing that ever activates a scene or macro
 *               (Alexa/SQS, the Insteon keypad listener, and the dashboard all
 *               route through handleRequest), so this module's own activation
 *               record is accurate the moment it is written. What it can't
 *               know statically, it *learns*: on scene activation it snapshots
 *               device state before and after a settle window and treats
 *               whatever changed as the scene's membership. That fingerprint
 *               is then compared against every subsequent device state message
 *               to detect drift -- someone changing a light by hand flips the
 *               scene back to inactive.
 *
 *               Macros interleave scene calls, device commands, and timing, so
 *               they get no fingerprint -- just a last-activation boolean.
 *
 *               Published (retained, QoS 1):
 *                 apollo/home/scene/<sceneId>/state
 *                   {active, activatedAt (unix seconds), fingerprint, source}
 *                 apollo/home/macro/<macroId>/state
 *                   {active, activatedAt (unix seconds), source}  -- no fingerprint
 *
 *               Declared blind spots (see plan §4.2 / §9): DMX and WLED
 *               publish no MQTT state at all, so scene members on those
 *               ecosystems are simply invisible to the fingerprint -- they
 *               never appear as a topic to diff or drift-check. Nothing
 *               special-cased here beyond "no state, no fingerprint entry".
 *               Same for color until Stage 12/§4.3 lands broadly.
 *
 *               TESTING NOTE: mirrors healthMonitor.js's shape. Real deps
 *               (mqttClient.subscribe/publish) are pulled in lazily via
 *               ensureInit() so requiring this file never connects to a
 *               broker. Tests call `_init({ subscribe, publish, settleMs,
 *               quietMs })` with fixture/spy functions and short timer
 *               durations first, then drive the module directly via
 *               onSceneActivated()/onMacroActivated()/_handleDeviceState()
 *               (the latter matching mqttClient's handler signature
 *               `(topic, payload, rawBuffer, retain)`) rather than going
 *               through start()'s real subscribe().
 */

'use strict';

let doSubscribe;
let doPublish;
let initialized = false;

// Fingerprint-learning timing (ms). Overridable via _init() so tests don't
// wait on the real ~3s settle window. See the module doc comment above for
// the two-phase behavior these implement (module doc for onSceneActivated
// has the detail).
let SETTLE_MS = 3000;
let QUIET_MS = 800;

/**
 * Lazily wires this module to the real mqttClient the first time it's
 * actually needed (start()/onSceneActivated()/etc). See the module doc
 * comment for why this is lazy rather than a top-level require.
 */
function ensureInit() {
    if (initialized) {
        return;
    }
    const mqttClient = require('./mqttClient');
    doSubscribe = mqttClient.subscribe;
    doPublish = mqttClient.publish;
    initialized = true;
}

/**
 * Test-only (and otherwise unused in production) override hook. See the
 * module doc comment above for why this exists.
 * @param {object} deps
 * @param {function} deps.subscribe - (topicFilter, handler) => void
 * @param {function} deps.publish - (topic, payload, opts) => void
 * @param {number} [deps.settleMs] - initial fingerprint settle window; defaults to 3000
 * @param {number} [deps.quietMs] - quiet-timer used to extend the settle window
 *   when state messages keep arriving; defaults to 800
 */
function _init({ subscribe, publish, settleMs, quietMs } = {}) {
    doSubscribe = subscribe;
    doPublish = publish;
    SETTLE_MS = Number.isFinite(settleMs) ? settleMs : 3000;
    QUIET_MS = Number.isFinite(quietMs) ? quietMs : 800;
    initialized = true;
}

// Per-device-state-topic tracking, fed by the apollo/+/+/+/state subscription.
// topic -> last known full state object (as published by mqttTopics.publishState,
// i.e. already merged -- carries forward every previously-known field).
const deviceStateByTopic = new Map();

// Scene shadow records: sceneId -> {active, activatedAt, fingerprint, source}
const sceneStateById = new Map();

// Macro shadow records: macroId -> {active, activatedAt, source} (no fingerprint)
const macroStateById = new Map();

// In-progress fingerprint-learning sessions: sceneId -> {t0Snapshot: Map, timer}
// Cancelable -- cleared whenever the scene is re-activated or turned off
// before the settle timer fires.
const learningBySceneId = new Map();

const RELEVANT_FIELDS = ['power', 'brightness', 'color', 'position'];
const TOLERANCE_FIELDS = new Set(['brightness', 'position']);
const TOLERANCE = 3;

/**
 * Extracts only the fingerprint-relevant fields from a raw device state
 * object (which also carries reachable/timestamp/source -- irrelevant here).
 * Fields absent from `state` are omitted rather than defaulted, so a
 * fingerprint entry only ever claims what was actually observed.
 * @param {object} state
 * @returns {object}
 */
function pickRelevant(state) {
    if (!state || typeof state !== 'object') {
        return {};
    }
    const out = {};
    for (const field of RELEVANT_FIELDS) {
        if (state[field] !== undefined) {
            out[field] = state[field];
        }
    }
    return out;
}

/**
 * Single field comparison used by both membership-diffing (t0 vs t1) and
 * drift detection (fingerprint vs live). brightness/position compare with a
 * tolerance band (>3 apart counts as different -- Insteon reported levels
 * round); power/color compare exactly. A field present on only one side
 * counts as different.
 * @param {string} field
 * @param {*} a
 * @param {*} b
 * @returns {boolean}
 */
function fieldDiffers(field, a, b) {
    if (a === undefined && b === undefined) {
        return false;
    }
    if (a === undefined || b === undefined) {
        return true;
    }
    if (TOLERANCE_FIELDS.has(field) && typeof a === 'number' && typeof b === 'number') {
        return Math.abs(a - b) > TOLERANCE;
    }
    return a !== b;
}

/**
 * Whether two raw device state objects differ on any fingerprint-relevant
 * field, per fieldDiffers()'s rule.
 * @param {object} a
 * @param {object} b
 * @returns {boolean}
 */
function statesDiffer(a, b) {
    const pa = pickRelevant(a);
    const pb = pickRelevant(b);
    for (const field of RELEVANT_FIELDS) {
        if (fieldDiffers(field, pa[field], pb[field])) {
            return true;
        }
    }
    return false;
}

function sceneTopic(sceneId) {
    return `apollo/home/scene/${sceneId}/state`;
}

function macroTopic(macroId) {
    return `apollo/home/macro/${macroId}/state`;
}

/**
 * Publishes the current shadow record for a scene, retained QoS 1.
 * @param {string} sceneId
 */
function publishSceneState(sceneId) {
    const record = sceneStateById.get(sceneId);
    if (!record) {
        return;
    }
    doPublish(sceneTopic(sceneId), {
        active: record.active,
        activatedAt: record.activatedAt,
        fingerprint: record.fingerprint || {},
        source: 'command',
    }, { qos: 1, retain: true });
}

/**
 * Publishes the current shadow record for a macro, retained QoS 1. No
 * fingerprint field -- macros interleave scenes/devices/timing and have no
 * meaningful device membership (see module doc comment).
 * @param {string} macroId
 */
function publishMacroState(macroId) {
    const record = macroStateById.get(macroId);
    if (!record) {
        return;
    }
    doPublish(macroTopic(macroId), {
        active: record.active,
        activatedAt: record.activatedAt,
        source: 'command',
    }, { qos: 1, retain: true });
}

/**
 * Cancels any in-progress fingerprint-learning session for a scene (clears
 * its settle/quiet timer). Safe to call when no session is in progress.
 * @param {string} sceneId
 */
function cancelLearning(sceneId) {
    const learning = learningBySceneId.get(sceneId);
    if (learning && learning.timer) {
        clearTimeout(learning.timer);
    }
    learningBySceneId.delete(sceneId);
}

/**
 * Shallow-copies the current device-state map (used as both the t0 and t1
 * snapshot for fingerprint learning).
 * @returns {Map<string, object>}
 */
function snapshotDeviceStates() {
    return new Map(deviceStateByTopic);
}

/**
 * Called when `lighting.js`'s `scene_command` activates a lightingScenes.json
 * entry. `active` is derived from the raw command (`OFF` -> inactive,
 * anything else -- typically `ON` -- -> active).
 *
 * Immediately publishes the scene's shadow state (active + activatedAt +
 * whatever fingerprint it already has -- preserved across a re-activation,
 * cleared on an explicit off). If turning on, also starts fingerprint
 * learning:
 *
 *   1. Snapshot every currently-tracked device's state (t0).
 *   2. Wait a settle window (SETTLE_MS, ~3s) for the hub to actually move
 *      the member devices. Every device state message that arrives while
 *      learning is in progress resets a shorter quiet-timer (QUIET_MS,
 *      ~800ms) instead of restarting the full settle window, so a scene
 *      touching several devices with staggered acks still finishes learning
 *      promptly once things go quiet.
 *   3. On timeout, snapshot again (t1). Membership = every topic whose
 *      state differs between t0 and t1 (statesDiffer()). Republish the
 *      scene's shadow state with the learned fingerprint.
 *
 * The learning session is cancelable: re-activating (on or off) the same
 * scene before the timer fires clears it, so a fingerprint from a
 * superseded activation never lands.
 *
 * @param {string} sceneId - lightingScenes.json entry id
 * @param {string} commandRaw - the raw command as passed to scene_command (e.g. "on"/"off")
 */
function onSceneActivated(sceneId, commandRaw) {
    ensureInit();

    const active = String(commandRaw).toUpperCase() !== 'OFF';
    const activatedAt = Math.floor(Date.now() / 1000);

    cancelLearning(sceneId);

    const previous = sceneStateById.get(sceneId);
    const fingerprint = active ? ((previous && previous.fingerprint) || {}) : {};

    sceneStateById.set(sceneId, { active, activatedAt, fingerprint, source: 'command' });
    publishSceneState(sceneId);

    if (!active) {
        return;
    }

    const t0Snapshot = snapshotDeviceStates();
    const timer = setTimeout(() => finalizeFingerprint(sceneId), SETTLE_MS);
    if (typeof timer.unref === 'function') {
        timer.unref();
    }
    learningBySceneId.set(sceneId, { t0Snapshot, timer });
}

/**
 * Settle/quiet-timer callback: snapshots current device state (t1), diffs it
 * against the learning session's t0 snapshot, and republishes the scene's
 * shadow state with the learned fingerprint. No-ops if the learning session
 * was already canceled, or if the scene is no longer active (defensive --
 * onSceneActivated() already cancels the timer in both cases, but a stray
 * fire is harmless either way).
 * @param {string} sceneId
 */
function finalizeFingerprint(sceneId) {
    const learning = learningBySceneId.get(sceneId);
    if (!learning) {
        return;
    }
    learningBySceneId.delete(sceneId);

    const record = sceneStateById.get(sceneId);
    if (!record || !record.active) {
        return;
    }

    const t1Snapshot = snapshotDeviceStates();
    const fingerprint = {};

    const allTopics = new Set([...learning.t0Snapshot.keys(), ...t1Snapshot.keys()]);
    for (const topic of allTopics) {
        const before = learning.t0Snapshot.get(topic);
        const after = t1Snapshot.get(topic);
        if (statesDiffer(before, after)) {
            fingerprint[topic] = pickRelevant(after);
        }
    }

    record.fingerprint = fingerprint;
    sceneStateById.set(sceneId, record);
    publishSceneState(sceneId);
}

/**
 * Called when `handler.js`'s `handleMacro` activates a macros.json entry.
 * Macros get no fingerprint -- just a last-activation boolean (see module
 * doc comment).
 * @param {string} macroId - macros.json entry id
 * @param {string} commandRaw - the raw command (e.g. "on"/"off")
 */
function onMacroActivated(macroId, commandRaw) {
    ensureInit();

    const active = String(commandRaw).toUpperCase() !== 'OFF';
    const activatedAt = Math.floor(Date.now() / 1000);

    macroStateById.set(macroId, { active, activatedAt, source: 'command' });
    publishMacroState(macroId);
}

/**
 * Handler for `apollo/+/+/+/state`. Maintains the device-state map used for
 * fingerprint learning and drift detection, matching mqttClient's handler
 * signature `(topic, payload, rawBuffer, retain)`. Non-object payloads
 * (defensive -- canonical state topics are always JSON) are ignored.
 *
 * Two responsibilities per message:
 *   1. If any scene has a fingerprint-learning session in progress, reset
 *      its quiet-timer (see onSceneActivated()'s doc comment) -- any device
 *      moving is a sign the hub is still settling.
 *   2. Drift detection: for every ACTIVE scene whose fingerprint includes
 *      this topic, compare the new state against the fingerprint entry
 *      (same tolerance rule as membership learning). A member outside
 *      tolerance flips that scene inactive and republishes (retained).
 *
 * @param {string} topic
 * @param {*} payload
 * @param {Buffer} [_raw] - unused; present so this matches mqttClient's
 *   handler signature positionally
 * @param {boolean} [_retain] - unused here (unlike healthMonitor, this
 *   module doesn't need to distinguish a retained replay from a live update
 *   -- both are equally valid "current state" for fingerprint/drift purposes)
 */
function _handleDeviceState(topic, payload, _raw, _retain) {
    ensureInit();

    if (!payload || typeof payload !== 'object') {
        return;
    }

    deviceStateByTopic.set(topic, payload);

    for (const [sceneId, learning] of learningBySceneId) {
        if (learning.timer) {
            clearTimeout(learning.timer);
        }
        const timer = setTimeout(() => finalizeFingerprint(sceneId), QUIET_MS);
        if (typeof timer.unref === 'function') {
            timer.unref();
        }
        learning.timer = timer;
    }

    for (const [sceneId, record] of sceneStateById) {
        if (!record.active || !record.fingerprint) {
            continue;
        }
        const fingerprintEntry = record.fingerprint[topic];
        if (!fingerprintEntry) {
            continue;
        }
        if (statesDiffer(fingerprintEntry, payload)) {
            record.active = false;
            sceneStateById.set(sceneId, record);
            publishSceneState(sceneId);
        }
    }
}

/**
 * Subscribes to the canonical device state topic filter. Safe to call once
 * at startup; this module never sends device commands, so it's safe in
 * dry-run and with the broker down (mqttClient queues/retries on its own).
 */
function start() {
    ensureInit();
    doSubscribe('apollo/+/+/+/state', _handleDeviceState);
}

/**
 * Test-only hook: clears all tracked state, shadow records, and any pending
 * learning timers so tests don't leak state (or live timers) into each
 * other. Never called from production code.
 */
function _resetForTesting() {
    deviceStateByTopic.clear();
    sceneStateById.clear();
    macroStateById.clear();
    for (const [, learning] of learningBySceneId) {
        if (learning.timer) {
            clearTimeout(learning.timer);
        }
    }
    learningBySceneId.clear();
}

module.exports = {
    start,
    onSceneActivated,
    onMacroActivated,
    _init,
    _handleDeviceState,
    _resetForTesting,
};
