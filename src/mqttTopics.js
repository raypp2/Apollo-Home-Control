/**
 * Apollo Home Control Bridge - MQTT Topics & State Cache
 * @module mqttTopics.js
 *
 * @description  The only place topic strings and payloads are constructed.
 *               Drivers never concatenate topic strings themselves -- they call
 *               topicFor()/publishState()/publishUnreachable() from here.
 *
 *               Like every other module in src/, this uses the standard
 *               `require('../index')` pattern and therefore must only be
 *               required after index.js has finished exporting its config
 *               (devices, lights, etc). Requiring this module boots the whole
 *               Apollo config-loading chain via index.js.
 *
 *               TESTING NOTE: test/mqttTopics.test.js needs to exercise the pure
 *               topic/payload logic below WITHOUT booting index.js (which reads
 *               config/*.json and starts servers as a side effect of being
 *               required). To make that possible, this module's dependencies
 *               (the `lights`/`devices` arrays and the `publish` function) are
 *               held in module-level variables that are populated lazily from
 *               '../index' on first real use, but can be overridden directly via
 *               `_init({ lights, devices, publish })`. Tests call `_init(...)`
 *               with fixture arrays and a spy `publish`, so requiring this file
 *               never triggers `require('../index')`. Production code paths
 *               never call `_init` -- they get the real config via the lazy
 *               `require('../index')` in `ensureInit()`.
 */

let lights;
let devices;
let doPublish;
let initialized = false;

/**
 * Lazily wires this module to the real Apollo config + mqttClient the first
 * time it's actually needed (topicFor/publishState/etc). Doing the require
 * lazily -- rather than at module load time -- means merely requiring
 * mqttTopics.js (e.g. transitively, or accidentally) doesn't boot index.js;
 * only calling one of its functions does. Tests avoid this entirely by calling
 * `_init()` first, which sets `initialized = true` and short-circuits this.
 */
function ensureInit() {
    if (initialized) {
        return;
    }
    const index = require('../index');
    const mqttClient = require('./mqttClient');
    lights = index.lights;
    devices = index.devices;
    doPublish = mqttClient.publish;
    initialized = true;
}

/**
 * Test-only (and otherwise unused in production) override hook. See the
 * module doc comment above for why this exists.
 * @param {object} deps
 * @param {Array} deps.lights
 * @param {Array} deps.devices
 * @param {function} deps.publish
 */
function _init({ lights: lightsOverride, devices: devicesOverride, publish: publishOverride }) {
    lights = lightsOverride;
    devices = devicesOverride;
    doPublish = publishOverride;
    initialized = true;
}

// In-memory cache of last-known state per entry, keyed by topicFor(entry, 'state').
// Doubles as the state source for /api/health (Stage 8) and optimistic-verification
// comparisons (Stage 3).
const stateCache = new Map();

const ECOSYSTEM_BY_TYPE = {
    insteon: 'insteon',
    'hue-group': 'hue',
    dmxFixture: 'dmx',
    shelly: 'shelly',
    wled: 'wled',
    iTach_serial: 'itach',
    iTach_ir: 'itach',
    iTach_CC: 'itach',
    ip_control: 'ip',
    'Somfy-Bridge': 'somfy',
    spotify: 'spotify',
};

/**
 * Lowercases a string and replaces spaces with hyphens (used for `location`).
 * @param {string} value
 * @returns {string}
 */
function slugify(value) {
    return String(value).toLowerCase().replace(/ /g, '-');
}

/**
 * Derives the ecosystem (topic level 3) from a config entry's `type` field.
 * @param {object} entry
 * @returns {string}
 */
function ecosystemFor(entry) {
    return ECOSYSTEM_BY_TYPE[entry && entry.type] || 'x';
}

/**
 * Builds the canonical topic for a config entry + attribute.
 * apollo/<location>/<ecosystem>/<mqttName>/<attribute>
 * @param {object} entry - a lights.json/devices.json entry
 * @param {string} attribute - e.g. 'state', 'set', 'status'
 * @returns {string}
 */
function topicFor(entry, attribute) {
    ensureInit();
    const location = slugify((entry && entry.location) || 'home');
    const ecosystem = ecosystemFor(entry);
    const mqttName = (entry && entry.mqttName) || (entry && entry.id);
    return `apollo/${location}/${ecosystem}/${mqttName}/${attribute}`;
}

/**
 * Merges `state` into the last-known state for this entry, stamps reachable/
 * timestamp/source, publishes retained QoS 1 JSON to topicFor(entry, 'state'),
 * and updates the in-memory cache.
 *
 * The merge matters: a brightness-only update must not erase a previously
 * known power field.
 *
 * @param {object} entry
 * @param {object} state - e.g. {power: "ON", brightness: 80}
 * @param {"command"|"event"|"poll"} source
 * @returns {object} the full merged+stamped state that was published
 */
function publishState(entry, state, source) {
    ensureInit();
    const topic = topicFor(entry, 'state');
    const previous = stateCache.get(topic) || {};

    const merged = {
        ...previous,
        ...state,
        reachable: true,
        timestamp: Math.floor(Date.now() / 1000),
        source,
    };

    stateCache.set(topic, merged);
    doPublish(topic, merged, { qos: 1, retain: true });

    return merged;
}

/**
 * Republishes the entry's last known state with reachable:false (retained),
 * and updates the cache to match. If there is no prior state, publishes a
 * minimal unreachable payload with no other fields.
 * @param {object} entry
 * @returns {object} the published payload
 */
function publishUnreachable(entry) {
    ensureInit();
    const topic = topicFor(entry, 'state');
    const previous = stateCache.get(topic) || {};

    const merged = {
        ...previous,
        reachable: false,
        timestamp: Math.floor(Date.now() / 1000),
    };

    stateCache.set(topic, merged);
    doPublish(topic, merged, { qos: 1, retain: true });

    return merged;
}

/**
 * Returns the cached state object for an entry, or null if nothing has been
 * published yet.
 * @param {object} entry
 * @returns {object|null}
 */
function lastState(entry) {
    ensureInit();
    const topic = topicFor(entry, 'state');
    return stateCache.get(topic) || null;
}

/**
 * Reverse lookup: given any `.../state` or `.../set` topic, returns the
 * matching config entry from lights or devices, or null if none match.
 * @param {string} topic
 * @returns {object|null}
 */
function findByTopic(topic) {
    ensureInit();
    const parts = topic.split('/');
    if (parts.length !== 5 || parts[0] !== 'apollo') {
        return null;
    }

    // Match on the FULL topic, not just mqttName -- the naming convention
    // encourages generic per-room names ("light" in both kitchen and hall),
    // so mqttName alone is not unique. Rebuilding each entry's canonical
    // topic and comparing catches location and ecosystem too.
    const attribute = parts[4];
    if (attribute !== 'state' && attribute !== 'set') {
        return null;
    }

    const all = [...(lights || []), ...(devices || [])];
    for (const entry of all) {
        if (topicFor(entry, attribute) === topic) {
            return entry;
        }
    }

    return null;
}

module.exports = {
    topicFor,
    publishState,
    publishUnreachable,
    lastState,
    findByTopic,
    _init,
};
