/**
 * Apollo Home Control Bridge - Health Monitor
 * @module healthMonitor.js
 *
 * @description  Stage 8 of the MQTT plan (issue #20). Read-only consumer of the
 *               canonical state bus: subscribes to every device's `.../state`
 *               topic plus bridge `.../status` LWT topics, tracks per-topic
 *               freshness, and flags per-ecosystem staleness on a timer. Also
 *               backs `GET /api/health` (see webServer.js).
 *
 *               This module never sends device commands -- its only writes are
 *               its own `apollo/health/...` status topics and (when a stale
 *               topic resolves to a config entry) a call to
 *               mqttTopics.publishUnreachable(entry), which republishes that
 *               device's own last-known state with reachable:false. It does
 *               not touch hardware directly.
 *
 *               Also piggybacks the mqttTopics.js merge-cache boot-seeding fix
 *               on this same `.../state` subscription: since this handler
 *               already receives every retained replay at startup/reconnect,
 *               _handleState() forwards retained deliveries to
 *               mqttTopics.seedFromRetained() so the merge cache isn't empty
 *               for the first partial publishState() after a restart. See
 *               _handleState()'s doc comment.
 *
 *               TESTING NOTE: like mqttTopics.js and lightingInsteonListener.js,
 *               this module's dependencies (mqttClient.subscribe/publish,
 *               mqttTopics.findByTopic/publishUnreachable/seedFromRetained) are
 *               lazily pulled in on first real use via ensureInit(), so merely
 *               requiring this file does not boot index.js or connect to a
 *               broker. Tests call `_init({ subscribe, publish, findByTopic,
 *               publishUnreachable })` with fixture/spy functions first
 *               (`seedFromRetained` is optional there, defaulting to a no-op).
 *               The periodic timers (`_tick(now)` for staleness,
 *               `_publishSummary(now)` for the summary) both take an explicit
 *               `now` (ms since epoch) so tests never need real timers.
 */

'use strict';

let doSubscribe;
let doPublish;
let doFindByTopic;
let doPublishUnreachable;
let doSeedFromRetained;
let initialized = false;

/**
 * Lazily wires this module to the real mqttClient/mqttTopics the first time
 * it's actually needed (start()/_tick()/etc). See the module doc comment for
 * why this is lazy rather than a top-level require.
 */
function ensureInit() {
    if (initialized) {
        return;
    }
    const mqttClient = require('./mqttClient');
    const mqttTopics = require('./mqttTopics');
    doSubscribe = mqttClient.subscribe;
    doPublish = mqttClient.publish;
    doFindByTopic = mqttTopics.findByTopic;
    doPublishUnreachable = mqttTopics.publishUnreachable;
    doSeedFromRetained = mqttTopics.seedFromRetained;
    initialized = true;
}

/**
 * Test-only (and otherwise unused in production) override hook. See the
 * module doc comment above for why this exists.
 * @param {object} deps
 * @param {function} deps.subscribe - (topicFilter, handler) => void
 * @param {function} deps.publish - (topic, payload, opts) => void
 * @param {function} deps.findByTopic - (topic) => entry|null
 * @param {function} deps.publishUnreachable - (entry) => object
 * @param {function} [deps.seedFromRetained] - (topic, payload) => void; optional,
 *   defaults to a no-op so existing test callers that don't pass it keep working
 */
function _init({ subscribe, publish, findByTopic, publishUnreachable, seedFromRetained }) {
    doSubscribe = subscribe;
    doPublish = publish;
    doFindByTopic = findByTopic;
    doPublishUnreachable = publishUnreachable;
    doSeedFromRetained = seedFromRetained || (() => {});
    initialized = true;
}

// Per-ecosystem staleness thresholds (ms). Ecosystems absent from this map
// are tracked in `stateByTopic` but never marked stale -- they aren't
// publishing state yet (hue, dmx, itach, ip, wled, x, spotify) or staleness
// isn't time-based for them (somfy: position only publishes on movement,
// silence of days is normal; reachability comes from the bridge LWT, which
// the somfy listener already maps to publishUnreachable on its own).
const STALE_THRESHOLD_MS = {
    insteon: 180000, // poll sweep ~60-90s; allow 2 misses
    shelly: 90000,   // pushes status periodically + has LWT
};

const TICK_INTERVAL_MS = 30000;
const SUMMARY_INTERVAL_MS = 300000;
const FUTURE_TIMESTAMP_SLOP_S = 60; // payload timestamps more than this far in the future are ignored

// Per-state-topic tracking: topic -> { lastSeen (ms epoch), lastState, stale (bool) }
const stateByTopic = new Map();

// Per-bridge-status-topic tracking: topic -> 'online' | 'offline'
const bridgeStatusByTopic = new Map();

let tickTimer = null;
let summaryTimer = null;

/**
 * Extracts the ecosystem (topic level 3) from a canonical state topic
 * `apollo/<location>/<ecosystem>/<mqttName>/state`.
 * @param {string} topic
 * @returns {string|null}
 */
function ecosystemOfTopic(topic) {
    const parts = topic.split('/');
    if (parts.length !== 5) {
        return null;
    }
    return parts[2];
}

/**
 * Extracts the `<location>/<mqttName>` pair from a canonical state topic, for
 * building the `apollo/health/<location>/<mqttName>/status` topic. Falls back
 * to reconstructing from the topic itself (not the config entry) so health
 * topics still publish even when no config entry resolves.
 * @param {string} topic
 * @returns {{location: string, mqttName: string}|null}
 */
function locationAndNameOfTopic(topic) {
    const parts = topic.split('/');
    if (parts.length !== 5) {
        return null;
    }
    return { location: parts[1], mqttName: parts[3] };
}

/**
 * Publishes the retained per-device health status topic
 * `apollo/health/<location>/<mqttName>/status` = "stale" | "ok".
 * @param {string} stateTopic
 * @param {"stale"|"ok"} status
 */
function publishDeviceHealth(stateTopic, status) {
    const parsed = locationAndNameOfTopic(stateTopic);
    if (!parsed) {
        return;
    }
    const topic = `apollo/health/${parsed.location}/${parsed.mqttName}/status`;
    doPublish(topic, status, { qos: 1, retain: true });
}

/**
 * Handler for `apollo/+/+/+/state`. Records/updates the per-topic record,
 * using the payload's own `timestamp` field (unix seconds) when present and
 * not implausibly far in the future (more than 60s ahead of receipt time --
 * a sane clock-skew allowance), else falls back to receipt time. Using the
 * payload's own timestamp lets retained messages replayed at startup/reconnect
 * seed the map with their ORIGINAL observation time, not the moment we happened
 * to reconnect.
 *
 * Clears any stale mark and publishes a recovery "ok" health status when a
 * fresh message arrives on a previously-stale topic.
 *
 * Also piggybacks the mqttTopics.js merge-cache seeding fix here (rather than
 * a second dedicated subscription) since this handler already sees every
 * retained replay of `apollo/+/+/+/state` at startup/reconnect: when `retain`
 * is true, forwards (topic, payload) to mqttTopics.seedFromRetained() so a
 * device's first partial publishState() after a restart merges against its
 * last-known full state instead of {}. seedFromRetained() only fills empty
 * cache slots, so this is safe to call on every retained delivery (including
 * reconnects) without risking clobbering fresher in-process state.
 *
 * Defensive: never throws on a malformed payload.
 * @param {string} topic
 * @param {*} payload
 * @param {Buffer} [_raw] - unused; present so this matches mqttClient's
 *   handler(topic, payload, rawBuffer, retain) signature positionally
 * @param {boolean} [retain] - true when this delivery is a retained replay
 *   (broker's retain flag for this delivery -- see mqttClient.js doc comment)
 */
function _handleState(topic, payload, _raw, retain) {
    ensureInit();

    const receivedAtMs = Date.now();
    let lastSeen = receivedAtMs;

    try {
        if (payload && typeof payload === 'object' && Number.isFinite(payload.timestamp)) {
            const payloadMs = payload.timestamp * 1000;
            if (payloadMs <= receivedAtMs + FUTURE_TIMESTAMP_SLOP_S * 1000) {
                lastSeen = payloadMs;
            }
            // else: implausibly-future timestamp -- keep receipt time.
        }
    } catch {
        // Never let a malformed payload's shape throw here -- fall through
        // with receivedAtMs already assigned.
    }

    const existing = stateByTopic.get(topic);
    const wasStale = !!(existing && existing.stale);

    stateByTopic.set(topic, {
        lastSeen,
        lastState: payload,
        stale: false,
    });

    if (wasStale) {
        console.log('Health: %s has recovered', topic);
        publishDeviceHealth(topic, 'ok');
    }

    if (retain) {
        try {
            doSeedFromRetained(topic, payload);
        } catch (err) {
            console.log('Health: seedFromRetained failed for %s: %s', topic, err && err.message);
        }
    }
}

/**
 * Handler for `apollo/bridge/+/status`. Payloads are plain "online"/"offline"
 * strings (mqttClient passes non-JSON payloads through as raw strings).
 * Defensive: unrecognized payload shapes are tracked as-is rather than thrown.
 * @param {string} topic
 * @param {*} payload
 */
function _handleBridgeStatus(topic, payload) {
    ensureInit();

    if (payload !== 'online' && payload !== 'offline') {
        console.log('Health: unrecognized bridge status payload on %s: %s', topic, JSON.stringify(payload));
        return;
    }

    bridgeStatusByTopic.set(topic, payload);
}

/**
 * One staleness-check pass over every tracked state topic. For each topic
 * whose ecosystem has a configured threshold and whose age exceeds it and
 * which isn't already marked stale: logs a warning, publishes retained
 * `apollo/health/<location>/<mqttName>/status` = "stale", and calls
 * mqttTopics.publishUnreachable() on the resolved config entry (skipped, but
 * the health topic still published, when no entry resolves). Marks the topic
 * stale in the map so this fires once per outage.
 *
 * Takes an explicit `now` (ms since epoch) so tests never need real timers.
 * @param {number} now
 */
function _tick(now) {
    ensureInit();

    for (const [topic, record] of stateByTopic) {
        if (record.stale) {
            continue;
        }

        const ecosystem = ecosystemOfTopic(topic);
        const threshold = STALE_THRESHOLD_MS[ecosystem];
        if (!threshold) {
            continue; // no time-based staleness for this ecosystem
        }

        const age = now - record.lastSeen;
        if (age <= threshold) {
            continue;
        }

        record.stale = true;
        console.log('%s has not reported state in %ds', topic, Math.round(age / 1000));
        publishDeviceHealth(topic, 'stale');

        try {
            const entry = doFindByTopic(topic);
            if (entry) {
                doPublishUnreachable(entry);
            }
        } catch (err) {
            console.log('Health: publishUnreachable failed for %s: %s', topic, err && err.message);
        }
    }
}

/**
 * Publishes the retained `apollo/health/summary` topic. Takes an explicit
 * `now` (ms since epoch) so tests never need real timers.
 * @param {number} now
 * @returns {object} the summary object that was published (also used by getHealth())
 */
function _publishSummary(now) {
    ensureInit();
    const summary = buildSummary(now);
    doPublish('apollo/health/summary', summary, { qos: 1, retain: true });
    return summary;
}

/**
 * Builds the summary object shape shared by _publishSummary() and getHealth().
 * @param {number} now
 * @returns {{timestamp: number, devices: number, stale: string[], bridges: object, degraded: boolean}}
 */
function buildSummary(now) {
    const stale = [];
    for (const [topic, record] of stateByTopic) {
        if (record.stale) {
            stale.push(topic);
        }
    }

    const bridges = {};
    for (const [topic, status] of bridgeStatusByTopic) {
        // apollo/bridge/<name>/status -> bridges.<name>
        const parts = topic.split('/');
        const name = parts.length >= 3 ? parts[2] : topic;
        bridges[name] = status;
    }

    const anyBridgeOffline = Object.values(bridges).some((status) => status !== 'online');
    const degraded = stale.length > 0 || anyBridgeOffline;

    return {
        timestamp: Math.floor(now / 1000),
        devices: stateByTopic.size,
        stale,
        bridges,
        degraded,
    };
}

/**
 * Subscribes to the canonical state and bridge-status topic filters and
 * starts the two periodic timers (staleness check every 30s, summary publish
 * every 5min). Both timers are unref'd so they never keep the process alive
 * on their own. Safe to call once at startup; calling again clears any prior
 * timers first (mirrors lightingInsteonListener's startInsteonPolling()).
 */
function start() {
    ensureInit();

    doSubscribe('apollo/+/+/+/state', _handleState);
    doSubscribe('apollo/bridge/+/status', _handleBridgeStatus);

    if (tickTimer) {
        clearInterval(tickTimer);
    }
    tickTimer = setInterval(() => _tick(Date.now()), TICK_INTERVAL_MS);
    if (typeof tickTimer.unref === 'function') {
        tickTimer.unref();
    }

    if (summaryTimer) {
        clearInterval(summaryTimer);
    }
    summaryTimer = setInterval(() => _publishSummary(Date.now()), SUMMARY_INTERVAL_MS);
    if (typeof summaryTimer.unref === 'function') {
        summaryTimer.unref();
    }
}

/**
 * Returns the current health snapshot: the same summary shape published to
 * `apollo/health/summary`, plus a per-device array. This is the exact
 * `/api/health` payload (see webServer.js).
 *
 * NOTE on time units: `summary.timestamp` (spread in from buildSummary(), the
 * same object shape published to the MQTT `apollo/health/summary` topic) is
 * in UNIX SECONDS -- that's left unchanged here since existing MQTT consumers
 * depend on it. Everything else in this HTTP payload is explicitly in
 * MILLISECONDS: the added top-level `nowMs` and each device's `lastSeenMs`
 * (renamed from the old ambiguous `lastSeen`, which looked like it might be
 * seconds next to `timestamp` but was always Date.now()-based ms). `ageSeconds`
 * remains seconds, as its name already says.
 * @returns {{timestamp: number, nowMs: number, devices: number, stale: string[],
 *            bridges: object, degraded: boolean,
 *            deviceDetail: Array<{topic: string, lastSeenMs: number,
 *            ageSeconds: number, stale: boolean, state: *}>}}
 */
function getHealth() {
    ensureInit();
    const now = Date.now();
    const summary = buildSummary(now);

    const deviceDetail = [];
    for (const [topic, record] of stateByTopic) {
        deviceDetail.push({
            topic,
            lastSeenMs: record.lastSeen,
            ageSeconds: Math.round((now - record.lastSeen) / 1000),
            stale: record.stale,
            state: record.lastState,
        });
    }

    return {
        ...summary,
        nowMs: now,
        deviceDetail,
    };
}

/**
 * Test-only hook: clears all tracked state/bridge records and timers so tests
 * don't leak state into each other. Never called from production code.
 */
function _resetForTesting() {
    stateByTopic.clear();
    bridgeStatusByTopic.clear();
    if (tickTimer) {
        clearInterval(tickTimer);
        tickTimer = null;
    }
    if (summaryTimer) {
        clearInterval(summaryTimer);
        summaryTimer = null;
    }
}

module.exports = {
    start,
    getHealth,
    _init,
    _tick,
    _publishSummary,
    _handleState,
    _handleBridgeStatus,
    _resetForTesting,
};
