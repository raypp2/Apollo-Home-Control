/**
 * Apollo Home Control Bridge - MQTT Orphaned Retained-State Topic Cleanup
 * @module mqttOrphanCleanup.js
 *
 * @description  Live-incident hardening fix. On the night this was written,
 *               two Insteon lights (`christmasTree`, `bedroom`) were removed
 *               entirely from config/lights.json. Their canonical MQTT state
 *               topics (apollo/home/insteon/christmasTree/state,
 *               apollo/home/insteon/bedroom/state) stayed retained on the
 *               broker from before the removal. Nothing ever re-published to
 *               them (they're gone from the poll rotation), so they sat as
 *               permanent ghosts -- healthMonitor.js seeded them from the
 *               retained replay at ITS OWN startup subscribe and flagged them
 *               stale forever, permanently reporting `degraded:true` on
 *               /api/health until a human manually cleared them with
 *               `mosquitto_pub -r -n` and restarted Apollo. This module makes
 *               that self-healing on every future restart.
 *
 *               How it works: subscribes to apollo/+/+/+/state (the same
 *               filter healthMonitor.js uses) for a short collection window
 *               right after connecting. Every RETAINED message delivered
 *               during that window is a candidate orphan -- retained delivery
 *               only happens for messages that were stored on the broker
 *               before this subscribe, either from a genuinely still-active
 *               device (which will re-publish fresh state shortly, but its
 *               retained replay looks identical to a ghost's during the
 *               window -- so we don't act on retained-ness alone) or from a
 *               device that's gone. A non-retained message during the window
 *               is a live device publishing right now, not a replay -- never
 *               treated as a candidate at all. After the window closes, every
 *               collected candidate topic is checked against the known-good
 *               set (topicFor(entry, 'state') for every current lights.json/
 *               devices.json entry, reusing mqttTopics.js's own topic-building
 *               logic rather than reimplementing ecosystem/location/mqttName
 *               defaulting here). Anything collected but NOT known-good gets
 *               its retained message cleared via the standard MQTT idiom: an
 *               empty payload published with retain:true.
 *
 *               Scope is deliberately narrow to apollo/+/+/+/state only. This
 *               does NOT touch apollo/health/... (healthMonitor's own status
 *               topics, which republish themselves fine), apollo/bridge/...
 *               (LWT status topics, same reasoning), or $aws/things/...
 *               (AWS IoT Core device shadows -- those live in AWS, not on the
 *               local Mosquitto broker, and clearing/reconciling a shadow
 *               needs the AWS SDK, not local MQTT publish/subscribe; that is
 *               a different cleanup problem for a different day).
 *
 *               One-shot only: this runs once per Apollo process lifetime, at
 *               startup, not on a recurring timer. Config (lights.json/
 *               devices.json) only changes between restarts -- a topic can
 *               only become orphaned by editing config and restarting, so a
 *               periodic re-sweep during a single already-running process
 *               would just repeat the same no-op check forever. Don't "fix"
 *               this into a poller; there's nothing new to find until the
 *               next restart, which re-runs this from scratch anyway.
 *
 *               TESTING NOTE: like every other module in src/, this module's
 *               dependencies (mqttClient.subscribe/publish, the lights/
 *               devices arrays, and the collection window) are lazily
 *               resolved on first real use via ensureInit(), so merely
 *               requiring this file never boots index.js or touches a real
 *               broker/timer. Tests call `_init({ subscribe, publish, lights,
 *               devices, collectionWindowMs })` with fixtures/spies and a
 *               short real window (e.g. 20ms) first -- mirroring
 *               healthMonitor.test.js's/mqttSetListener.test.js's "call the
 *               captured handler directly to simulate delivery" approach and
 *               lightingInsteonListener.test.js's injectable-delay pattern
 *               (real but short timers, not a mocked clock).
 */

'use strict';

const STATE_TOPIC_FILTER = 'apollo/+/+/+/state';
const DEFAULT_COLLECTION_WINDOW_MS = 1500;

// Reserved app-published state topics that match STATE_TOPIC_FILTER but do NOT
// correspond to any lights.json/devices.json entry, so they must never be
// treated as orphans: scene/macro shadow state (src/sceneShadow.js) and
// Spotify now-playing (src/spotify.js). Without this guard the cleanup would
// wipe them on every restart.
const RESERVED_STATE_PREFIXES = ['apollo/home/scene/', 'apollo/home/macro/', 'apollo/home/spotify/'];

function isReservedStateTopic(topic) {
    return RESERVED_STATE_PREFIXES.some((prefix) => topic.startsWith(prefix));
}

let doSubscribe;
let doPublish;
let doTopicFor;
let lights;
let devices;
let collectionWindowMs = DEFAULT_COLLECTION_WINDOW_MS;
let initialized = false;

/**
 * Lazily wires this module to the real mqttClient/mqttTopics/config the first
 * time it's actually needed (cleanupOrphanedStateTopics()). See the module
 * doc comment for why this is lazy rather than a top-level require.
 */
function ensureInit() {
    if (initialized) {
        return;
    }
    const mqttClient = require('./mqttClient');
    const mqttTopics = require('./mqttTopics');
    const index = require('../index');
    doSubscribe = mqttClient.subscribe;
    doPublish = mqttClient.publish;
    doTopicFor = mqttTopics.topicFor;
    lights = index.lights;
    devices = index.devices;
    initialized = true;
}

/**
 * Test-only (and otherwise unused in production) override hook. See the
 * module doc comment above for why this exists. Note: `topicFor` itself is
 * still pulled from the real mqttTopics.js module (not injectable here) --
 * tests get fixture behavior out of it by calling mqttTopics.js's own
 * `_init({ lights, devices, publish })` first, exactly like
 * lightingInsteonListener.test.js does.
 * @param {object} deps
 * @param {function} [deps.subscribe] - (topicFilter, handler) => void
 * @param {function} [deps.publish] - (topic, payload, opts) => void
 * @param {Array} [deps.lights]
 * @param {Array} [deps.devices]
 * @param {number} [deps.collectionWindowMs]
 */
function _init({ subscribe, publish, lights: lightsOverride, devices: devicesOverride, collectionWindowMs: windowOverride } = {}) {
    const mqttTopics = require('./mqttTopics');
    doSubscribe = subscribe || (() => {});
    doPublish = publish || (() => {});
    doTopicFor = mqttTopics.topicFor;
    lights = lightsOverride;
    devices = devicesOverride;
    collectionWindowMs = (typeof windowOverride === 'number') ? windowOverride : DEFAULT_COLLECTION_WINDOW_MS;
    initialized = true;
}

/**
 * Builds the set of canonical `.../state` topics for every current
 * lights.json/devices.json entry. Defensive: a missing/non-array lights or
 * devices, or a single malformed entry that makes topicFor() throw, is logged
 * and skipped rather than crashing the sweep.
 * @returns {Set<string>}
 */
function buildKnownGoodTopics() {
    const knownGoodTopics = new Set();
    const all = [
        ...(Array.isArray(lights) ? lights : []),
        ...(Array.isArray(devices) ? devices : []),
    ];

    for (const entry of all) {
        try {
            const topic = doTopicFor(entry, 'state');
            if (topic) {
                knownGoodTopics.add(topic);
            }
        } catch (err) {
            console.log('Orphan topic cleanup: failed to compute topic for a config entry: %s', err && err.message);
        }
    }

    return knownGoodTopics;
}

/**
 * Clears a single orphaned retained topic via the standard MQTT
 * retained-message-delete idiom: an empty payload published with
 * retain:true. Wrapped in try/catch so one bad publish never stops the rest
 * of the sweep.
 * @param {string} topic
 */
function pruneTopic(topic) {
    try {
        doPublish(topic, '', { qos: 1, retain: true });
        console.log('Orphan topic cleanup: pruned retained state for decommissioned device: %s', topic);
    } catch (err) {
        console.log('Orphan topic cleanup: failed to prune %s: %s', topic, err && err.message);
    }
}

/**
 * The single entry point. Subscribes to apollo/+/+/+/state, collects every
 * RETAINED delivery for `collectionWindowMs` (default 1500ms), then prunes
 * every collected topic that isn't in the current lights.json/devices.json
 * known-good set. Never throws and never rejects -- every internal failure
 * (subscribe failure, malformed config, a publish failure) is caught and
 * logged so a caller that doesn't await this can't crash startup on it.
 * @returns {Promise<void>} resolves once the collection window has elapsed
 *   and any prunes have been issued.
 */
function cleanupOrphanedStateTopics() {
    ensureInit();

    return new Promise((resolve) => {
        let knownGoodTopics;
        try {
            knownGoodTopics = buildKnownGoodTopics();
        } catch (err) {
            console.log('Orphan topic cleanup: failed to build known-good topic set: %s', err && err.message);
            knownGoodTopics = new Set();
        }

        const collectedRetainedTopics = new Set();

        function handleStateMessage(topic, payload, raw, retain) {
            if (retain) {
                collectedRetainedTopics.add(topic);
            }
            // Non-retained messages during the window are live devices
            // publishing right now, not orphan candidates -- ignored.
        }

        try {
            doSubscribe(STATE_TOPIC_FILTER, handleStateMessage);
        } catch (err) {
            console.log('Orphan topic cleanup: failed to subscribe to %s: %s', STATE_TOPIC_FILTER, err && err.message);
        }

        // Deliberately NOT unref'd: this is a short one-shot timer (default
        // 1500ms, or a few ms in tests), not a recurring interval like
        // healthMonitor.js's timers -- there is no risk of it keeping the
        // process alive indefinitely, and unref'ing it would let a bare
        // `node --test` runner (nothing else keeping the event loop busy)
        // exit before the window elapses, cancelling this promise early.
        setTimeout(() => {
            let prunedCount = 0;
            for (const topic of collectedRetainedTopics) {
                if (!knownGoodTopics.has(topic) && !isReservedStateTopic(topic)) {
                    pruneTopic(topic);
                    prunedCount++;
                }
            }
            if (prunedCount === 0) {
                console.log('Orphan topic cleanup: 0 orphaned topics found');
            }
            resolve();
        }, collectionWindowMs);
    });
}

module.exports = {
    cleanupOrphanedStateTopics,
    _init,
};
