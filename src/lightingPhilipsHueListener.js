/**
 * Apollo Home Control Bridge - Philips Hue SSE Listener Module
 * @module lightingPhilipsHueListener.js
 *
 * @description  Stage 4 of the MQTT plan (issue #12). Subscribes to the Hue
 *               bridge's own event stream (`/eventstream/clip/v2`, CLIP v2
 *               server-sent events) for near-real-time state and republishes
 *               canonical MQTT state via mqttTopics -- mirrors the pattern
 *               used by lightingShelly.js/somfyBridge.js (native events ->
 *               normalizer -> publishState), except here Apollo itself opens
 *               and maintains the event-stream connection (Hue has no
 *               separate native MQTT broker the way Shelly/ESPSomfy do).
 *
 *               Deviations from documentation/mqtt-implementation-detail.md
 *               (verified live against the real bridge, trusted over the doc
 *               where they differ):
 *               - Uses Node's `https` module directly (`https.request`/
 *                 `https.get` with `rejectUnauthorized: false` scoped to just
 *                 these bridge calls), NOT `fetch` -- Node's bundled undici
 *                 has no per-request way to relax TLS for the bridge's
 *                 self-signed cert without a new dependency, and
 *                 NODE_TLS_REJECT_UNAUTHORIZED must never be set globally.
 *               - healthMonitor.js deliberately has NO time-based staleness
 *                 threshold for the "hue" ecosystem: the SSE stream is silent
 *                 whenever nothing changes, so a staleness timer would false-
 *                 alarm constantly. Reachability instead comes from this
 *                 module's own `apollo/bridge/hue-sse/status` topic (online
 *                 when the stream is connected, offline while reconnecting/
 *                 polling). Do not add a "hue" entry to healthMonitor's
 *                 STALE_THRESHOLD_MS.
 *               - Only `grouped_light` resource events are handled (the two
 *                 configured hue-group lights.json entries are groups; the
 *                 detail doc's mention of `/light` events is out of scope
 *                 here). Anything else is ignored silently.
 *
 *               UUID mapping: CLIP v2 identifies resources by UUID, but
 *               lights.json's `address` field is the legacy v1 group number
 *               ("5", "3", ...). At startup, GET /clip/v2/resource/grouped_light
 *               and match each item's `id_v1` ("/groups/5") against a
 *               lights.json entry's `address` to build {uuid -> entry}. That
 *               fetch is retried with backoff so a bridge that's briefly
 *               unreachable at Apollo boot doesn't permanently disable the
 *               listener.
 *
 *               Reconnect: on stream error/close, retries with capped
 *               exponential backoff (5s -> 60s). While disconnected, falls
 *               back to polling the legacy v1 `GET /api/<key>/groups` every
 *               10s so state doesn't go stale for long outages; the fallback
 *               poll stops the moment the SSE stream reconnects.
 *
 *               TESTING NOTE: like the other listener modules, this module's
 *               dependency on `lights.json` is lazily pulled from '../index'
 *               on first real use (ensureInit()), with a test-only
 *               `_init({ lights, publish, uuidMap })` override. mqttTopics.js
 *               is required directly at module scope (like lightingShelly.js
 *               does) since mqttTopics itself is lazy and requiring it does
 *               not boot index.js; tests wire it via mqttTopics._init(...)
 *               exactly like test/lightingShelly.test.js. No real network
 *               calls happen in unit tests -- the SSE parser is exercised via
 *               the exported `_ingest(chunk)` hook, and the UUID-map/v1-poll
 *               mapping logic is exercised via pure exported functions
 *               (`_buildUuidMapFromResource`, `_mapV1GroupState`) fed fixture
 *               data directly, never a real HTTPS response.
 */

'use strict';

const https = require('https');
const mqttClient = require('./mqttClient');
const mqttTopics = require('./mqttTopics');

const BRIDGE_STATUS_TOPIC = 'apollo/bridge/hue-sse/status';

const INITIAL_BACKOFF_MS = 5000;
const MAX_BACKOFF_MS = 60000;
const FALLBACK_POLL_INTERVAL_MS = 10000;

let lights_new;
let doPublish; // bridge-status publish -- mqttClient.publish by default, injectable for tests
let hueHost;
let hueKey;
let initialized = false;

/**
 * Lazily wires this module to the real Apollo config + env the first time
 * it's actually needed. See the module doc comment for why this is lazy
 * rather than a top-level require('../index').
 */
function ensureInit() {
    if (initialized) {
        return;
    }
    const index = require('../index');
    lights_new = index.lights;
    doPublish = mqttClient.publish;
    hueHost = process.env.PHILIPS_HUE_IP;
    hueKey = process.env.PHILIPS_HUE_USERNAME;
    initialized = true;
}

/**
 * Test-only (and otherwise unused in production) override hook. See the
 * module doc comment above for why this exists.
 * @param {object} deps
 * @param {Array} deps.lights
 * @param {function} [deps.publish] - (topic, payload, opts) => void, defaults to mqttClient.publish
 * @param {Map<string,object>} [deps.uuidMap] - pre-seeded uuid->entry map, skips the real fetch
 */
function _init({ lights: lightsOverride, publish: publishOverride, uuidMap: uuidMapOverride }) {
    lights_new = lightsOverride;
    doPublish = publishOverride || mqttClient.publish;
    if (uuidMapOverride) {
        uuidMap = uuidMapOverride;
    }
    initialized = true;
}

// ################# UUID MAPPING #################

// uuid (CLIP v2 resource id) -> lights.json entry
let uuidMap = new Map();

// uuid -> { color, color_temperature } -- stashed alongside the derived hex
// published in state.color (see _xyToHex below); color_temperature itself is
// still not published (full Stage 12 CT support is out of scope here).
const trackedExtras = new Map();

/**
 * Converts a CIE 1931 xy chromaticity point (plus 0-1 brightness) to an
 * approximate '#rrggbb' hex string (lowercase). This is the standard Philips
 * reverse xy->RGB transform -- the same formula node-hue-api ships in its
 * (unexported) rgb.ts, reimplemented here rather than reaching into that
 * package's internals. It's documented there as "a gross approximation" of
 * true gamut-aware conversion, but adequate for reflecting an externally-set
 * color back onto the dashboard as a swatch.
 * @param {number} x
 * @param {number} y
 * @param {number} [brightness=1] - 0-1 (Y in the CIE XYZ conversion)
 * @returns {string|null} '#rrggbb', or null if x/y aren't usable
 */
function _xyToHex(x, y, brightness) {
    if (typeof x !== 'number' || typeof y !== 'number' || y === 0) {
        return null;
    }
    const Y = typeof brightness === 'number' ? brightness : 1;
    const X = (Y / y) * x;
    const Z = (Y / y) * (1 - x - y);

    let rgb = [
        X * 1.612 - Y * 0.203 - Z * 0.302,
        -X * 0.509 + Y * 1.412 + Z * 0.066,
        X * 0.026 - Y * 0.072 + Z * 0.962,
    ];

    // Reverse gamma correction.
    rgb = rgb.map((c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055));
    // Clamp negative components to zero.
    rgb = rgb.map((c) => Math.max(0, c));

    // If any component overflows 1, scale the whole triplet down to fit.
    const max = Math.max(rgb[0], rgb[1], rgb[2]);
    if (max > 1) {
        rgb = rgb.map((c) => c / max);
    }

    const [r, g, b] = rgb.map((c) => Math.min(255, Math.round(c * 255)));
    return '#' + [r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('');
}

/**
 * Parses a CLIP v2 `id_v1` field ("/groups/5") into the legacy group number
 * ("5", a string, matching lights.json's `address` field type) or null if it
 * doesn't look like a group id_v1 at all.
 * @param {*} idV1
 * @returns {string|null}
 */
function v1GroupNumber(idV1) {
    if (typeof idV1 !== 'string') {
        return null;
    }
    const match = idV1.match(/^\/groups\/(\d+)$/);
    return match ? match[1] : null;
}

/**
 * Pure mapping function: given the CLIP v2 `/clip/v2/resource/grouped_light`
 * response's `data` array and a lights.json array, builds {uuid -> entry}
 * for every hue-group entry with a matching group resource. Logs (once per
 * call -- i.e. once at startup, plus once per retry if the initial fetch
 * failed) any config entry with no matching group and any group resource
 * with no matching config entry, per the Stage 4 spec. Exported for direct
 * unit testing with fixture data -- never touches the network itself.
 * @param {Array} data
 * @param {Array} lightsList
 * @returns {Map<string,object>}
 */
function _buildUuidMapFromResource(data, lightsList) {
    const list = Array.isArray(lightsList) ? lightsList : [];
    const items = Array.isArray(data) ? data : [];
    const map = new Map();
    const matchedAddresses = new Set();

    for (const item of items) {
        const groupNum = v1GroupNumber(item && item.id_v1);
        if (groupNum === null) {
            continue;
        }
        const entry = list.find((candidate) => candidate && candidate.type === 'hue-group' && candidate.address === groupNum);
        if (entry) {
            map.set(item.id, entry);
            matchedAddresses.add(groupNum);
        } else {
            console.log('Hue SSE: grouped_light group %s (uuid %s) has no matching lights.json entry', groupNum, item.id);
        }
    }

    for (const entry of list) {
        if (entry && entry.type === 'hue-group' && entry.address && !matchedAddresses.has(entry.address)) {
            console.log('Hue SSE: lights.json entry "%s" (address %s) has no matching Hue grouped_light resource', entry.id, entry.address);
        }
    }

    return map;
}

let uuidMapRetryDelay = INITIAL_BACKOFF_MS;

/**
 * Fetches /clip/v2/resource/grouped_light and builds the uuid map. On
 * failure (bridge briefly unreachable at boot, etc), retries with capped
 * exponential backoff instead of giving up -- see module doc comment. Once
 * the map is built, proceeds to open the SSE stream.
 */
function initUuidMapWithRetry() {
    httpsGetJson('/clip/v2/resource/grouped_light', { 'hue-application-key': hueKey })
        .then((body) => {
            uuidMap = _buildUuidMapFromResource(body && body.data, lights_new);
            uuidMapRetryDelay = INITIAL_BACKOFF_MS;
            connectSSE();
        })
        .catch((err) => {
            console.log('Hue SSE: failed to build UUID map (%s) -- retrying in %dms', err.message, uuidMapRetryDelay);
            const timer = setTimeout(initUuidMapWithRetry, uuidMapRetryDelay);
            if (typeof timer.unref === 'function') {
                timer.unref();
            }
            uuidMapRetryDelay = Math.min(uuidMapRetryDelay * 2, MAX_BACKOFF_MS);
        });
}

// ################# SSE PARSER #################

// Accumulates partial SSE bytes across chunks/frames. A "frame" is one SSE
// event, terminated by a blank line (\n\n); a frame's data may itself span
// several `data:` lines (concatenated per the SSE spec) and may arrive split
// across multiple TCP chunks -- we only attempt to parse once a full \n\n has
// been seen, so a JSON payload split mid-chunk is naturally handled by simply
// not having a complete frame yet.
let sseBuffer = '';

/**
 * Feeds raw bytes from the SSE response stream into the parser. Splits
 * complete frames on the blank-line terminator and hands each off to
 * _processFrame(). Exported as the test hook for exercising the parser (and,
 * transitively, dispatch) without a real network connection.
 * @param {string} chunk
 */
function _ingest(chunk) {
    sseBuffer += chunk;

    let idx;
    while ((idx = sseBuffer.indexOf('\n\n')) !== -1) {
        const frame = sseBuffer.slice(0, idx);
        sseBuffer = sseBuffer.slice(idx + 2);
        _processFrame(frame);
    }
}

/**
 * Parses one complete SSE frame: extracts and concatenates every `data:`
 * line (ignoring comment lines starting with ':', e.g. the ": hi" handshake,
 * and `id:` lines), JSON.parses the result (an array of CLIP v2 event
 * batches), and dispatches each batch. Malformed JSON is logged and
 * swallowed, never thrown.
 * @param {string} frame
 */
function _processFrame(frame) {
    const dataLines = [];

    for (const line of frame.split('\n')) {
        if (line.startsWith(':')) {
            continue; // comment line, e.g. the ": hi" handshake
        }
        if (line.startsWith('id:')) {
            continue; // event id -- not needed
        }
        if (line.startsWith('data:')) {
            // Per the SSE spec, a single space after the colon (if present) is
            // stripped; the rest of the line is kept verbatim.
            dataLines.push(line.startsWith('data: ') ? line.slice(6) : line.slice(5));
        }
        // Other SSE fields (event:, retry:) are intentionally ignored.
    }

    if (dataLines.length === 0) {
        return;
    }

    let batches;
    try {
        batches = JSON.parse(dataLines.join('\n'));
    } catch (err) {
        console.log('Hue SSE: malformed JSON frame, ignoring: %s', err.message);
        return;
    }

    if (!Array.isArray(batches)) {
        return;
    }

    for (const batch of batches) {
        _handleBatch(batch);
    }
}

/**
 * Handles one CLIP v2 event batch (`{type: "update", data: [...]}`),
 * dispatching each resource item within it.
 * @param {object} batch
 */
function _handleBatch(batch) {
    if (!batch || !Array.isArray(batch.data)) {
        return;
    }
    for (const item of batch.data) {
        _handleResourceItem(item);
    }
}

/**
 * Handles one CLIP v2 resource item from an event batch. Only
 * `grouped_light` items resolve to canonical state -- anything else, or a
 * `grouped_light` whose uuid isn't in the map, is ignored silently. Only the
 * fields actually present in the event are published (publishState's own
 * merge preserves anything not present, e.g. a brightness-only event must
 * not fabricate a power value). Also stashes color/color_temperature on the
 * tracked-extras map (kept for future color_temperature support -- full CT
 * publishing is still out of scope here); `item.color`'s xy point, if
 * present, is additionally converted to a '#rrggbb' hex and included in the
 * published state so an external color change (e.g. made from the Hue app)
 * reflects on the dashboard.
 * @param {object} item
 */
function _handleResourceItem(item) {
    if (!item || item.type !== 'grouped_light' || !item.id) {
        return;
    }

    const entry = uuidMap.get(item.id);
    if (!entry) {
        return; // unknown uuid -- ignore silently
    }

    if (item.color || item.color_temperature) {
        const extras = trackedExtras.get(item.id) || {};
        if (item.color) {
            extras.color = item.color;
        }
        if (item.color_temperature) {
            extras.color_temperature = item.color_temperature;
        }
        trackedExtras.set(item.id, extras);
    }

    const state = {};
    if (item.on && typeof item.on.on === 'boolean') {
        state.power = item.on.on ? 'ON' : 'OFF';
    }
    if (item.dimming && typeof item.dimming.brightness === 'number') {
        state.brightness = Math.round(item.dimming.brightness);
    }
    if (item.color && item.color.xy && typeof item.color.xy.x === 'number' && typeof item.color.xy.y === 'number') {
        // Prefer this same event's brightness for the xy->RGB conversion;
        // fall back to the last known brightness on the entry, then to full
        // brightness if neither is known (xy alone doesn't carry luminance).
        const briPercent = typeof state.brightness === 'number' ? state.brightness
            : typeof entry.status === 'number' ? entry.status
                : 100;
        const hex = _xyToHex(item.color.xy.x, item.color.xy.y, briPercent / 100);
        if (hex) {
            state.color = hex;
        }
    }

    if (Object.keys(state).length === 0) {
        return;
    }

    mqttTopics.publishState(entry, state, 'event');

    if ('power' in state) {
        entry.checked = (state.power === 'ON');
    }
    if ('brightness' in state) {
        entry.status = state.brightness;
    }
}

// ################# SSE CONNECTION + RECONNECT #################

let sseRequest = null;
let reconnectTimer = null;
let reconnectDelay = INITIAL_BACKOFF_MS;
let torndown = true; // starts "torn down" so a stray disconnect before the first connect is a no-op

/**
 * Publishes the retained bridge-reachability status topic
 * `apollo/bridge/hue-sse/status` = "online" | "offline".
 * @param {"online"|"offline"} status
 */
function publishBridgeStatus(status) {
    doPublish(BRIDGE_STATUS_TOPIC, status, { qos: 1, retain: true });
}

/**
 * Opens the SSE connection to the Hue bridge's CLIP v2 event stream.
 * Self-signed cert -- rejectUnauthorized:false scoped to just this request,
 * per the module doc comment (never set globally). On a successful 200
 * response, marks the bridge online and stops the fallback poll. On any
 * failure to connect, or the stream closing/erroring afterward, tears down
 * and schedules a reconnect (see handleDisconnect()).
 */
function connectSSE() {
    torndown = false;
    sseBuffer = '';

    const req = https.request(
        {
            hostname: hueHost,
            path: '/eventstream/clip/v2',
            method: 'GET',
            headers: {
                'hue-application-key': hueKey,
                Accept: 'text/event-stream',
            },
            rejectUnauthorized: false,
        },
        (res) => {
            if (res.statusCode !== 200) {
                console.log('Hue SSE: unexpected status %d connecting to event stream', res.statusCode);
                res.resume();
                handleDisconnect();
                return;
            }

            console.log('Hue SSE: connected');
            onConnected();

            res.setEncoding('utf8');
            res.on('data', _ingest);
            res.on('end', () => {
                console.log('Hue SSE: stream ended');
                handleDisconnect();
            });
            res.on('error', (err) => {
                console.log('Hue SSE: stream error: %s', err.message);
                handleDisconnect();
            });
        }
    );

    req.on('error', (err) => {
        console.log('Hue SSE: connection error: %s', err.message);
        handleDisconnect();
    });

    req.end();
    sseRequest = req;
}

/**
 * Called once the SSE stream's headers confirm a 200 connection. Resets the
 * reconnect backoff, stops the fallback poll (no longer needed), and
 * publishes the bridge-online status.
 */
function onConnected() {
    reconnectDelay = INITIAL_BACKOFF_MS;
    stopFallbackPoll();
    publishBridgeStatus('online');
}

/**
 * Tears down after a connect failure or a stream error/close. Guarded by
 * `torndown` so the 'error' and 'end'/status-code-failure paths (which can
 * both fire for the same underlying disconnect) don't double-schedule a
 * reconnect or double-start the fallback poll.
 */
function handleDisconnect() {
    if (torndown) {
        return;
    }
    torndown = true;

    if (sseRequest) {
        try {
            sseRequest.destroy();
        } catch {
            // Already dead -- nothing to do.
        }
        sseRequest = null;
    }

    publishBridgeStatus('offline');
    startFallbackPoll();
    scheduleReconnect();
}

/**
 * Schedules the next connectSSE() attempt with capped exponential backoff
 * (5s -> 60s). A no-op if a reconnect is already scheduled.
 */
function scheduleReconnect() {
    if (reconnectTimer) {
        return;
    }
    const delay = reconnectDelay;
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connectSSE();
    }, delay);
    if (typeof reconnectTimer.unref === 'function') {
        reconnectTimer.unref();
    }
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_BACKOFF_MS);
}

// ################# V1 FALLBACK POLL #################

let fallbackPollTimer = null;

/**
 * Pure mapping function: given one v1 `/api/<key>/groups` group object,
 * derives the partial canonical state to publish, or null if nothing usable
 * is present. `action.on` is preferred for power (matches what a command
 * just set); `state.any_on` is the fallback. `action.bri` is 0-254 and is
 * scaled to a 0-100 percentage. `action.xy` (a [x, y] pair, same CIE
 * chromaticity the SSE path receives) is converted to a '#rrggbb' hex the
 * same way _handleResourceItem does, using this same tick's brightness for
 * the conversion. Exported for direct unit testing -- never touches the
 * network itself.
 * @param {object} group
 * @returns {{power?: string, brightness?: number, color?: string}|null}
 */
function _mapV1GroupState(group) {
    if (!group) {
        return null;
    }

    const state = {};

    if (group.action && typeof group.action.on === 'boolean') {
        state.power = group.action.on ? 'ON' : 'OFF';
    } else if (group.state && typeof group.state.any_on === 'boolean') {
        state.power = group.state.any_on ? 'ON' : 'OFF';
    }

    if (group.action && typeof group.action.bri === 'number') {
        state.brightness = Math.round((group.action.bri / 254) * 100);
    }

    if (group.action && Array.isArray(group.action.xy) && group.action.xy.length === 2) {
        const briFraction = typeof state.brightness === 'number' ? state.brightness / 100
            : typeof group.action.bri === 'number' ? group.action.bri / 254
                : 1;
        const hex = _xyToHex(group.action.xy[0], group.action.xy[1], briFraction);
        if (hex) {
            state.color = hex;
        }
    }

    return Object.keys(state).length > 0 ? state : null;
}

/**
 * One fallback-poll tick: fetches the legacy v1 groups resource and
 * publishes poll-sourced state for every configured hue-group light present
 * in the response. Never throws -- a fetch failure is logged and simply
 * tried again on the next tick.
 */
function fallbackPollTick() {
    httpsGetJson(`/api/${hueKey}/groups`, {})
        .then((body) => {
            const targets = (lights_new || []).filter((entry) => entry && entry.type === 'hue-group' && entry.address);
            for (const entry of targets) {
                const group = body && body[entry.address];
                const state = _mapV1GroupState(group);
                if (!state) {
                    continue;
                }

                mqttTopics.publishState(entry, state, 'poll');

                if ('power' in state) {
                    entry.checked = (state.power === 'ON');
                }
                if ('brightness' in state) {
                    entry.status = state.brightness;
                }
            }
        })
        .catch((err) => {
            console.log('Hue SSE: fallback poll failed: %s', err.message);
        });
}

/**
 * Starts the v1 fallback poll (every 10s, unref'd). A no-op if already
 * running.
 */
function startFallbackPoll() {
    if (fallbackPollTimer) {
        return;
    }
    fallbackPollTimer = setInterval(fallbackPollTick, FALLBACK_POLL_INTERVAL_MS);
    if (typeof fallbackPollTimer.unref === 'function') {
        fallbackPollTimer.unref();
    }
}

/**
 * Stops the v1 fallback poll -- called the moment the SSE stream reconnects.
 */
function stopFallbackPoll() {
    if (fallbackPollTimer) {
        clearInterval(fallbackPollTimer);
        fallbackPollTimer = null;
    }
}

// ################# SHARED HTTPS HELPER #################

/**
 * GETs a path on the Hue bridge and parses the response as JSON. Self-signed
 * cert -- rejectUnauthorized:false scoped to just this request, per the
 * module doc comment. Rejects on a non-2xx status or unparsable body.
 * @param {string} path
 * @param {object} headers
 * @returns {Promise<object>}
 */
function httpsGetJson(path, headers) {
    return new Promise((resolve, reject) => {
        const req = https.get(
            {
                hostname: hueHost,
                path,
                headers,
                rejectUnauthorized: false,
            },
            (res) => {
                let body = '';
                res.setEncoding('utf8');
                res.on('data', (chunk) => {
                    body += chunk;
                });
                res.on('end', () => {
                    if (res.statusCode < 200 || res.statusCode >= 300) {
                        reject(new Error(`HTTP ${res.statusCode} for ${path}`));
                        return;
                    }
                    try {
                        resolve(body ? JSON.parse(body) : {});
                    } catch (err) {
                        reject(err);
                    }
                });
            }
        );
        req.on('error', reject);
        req.end();
    });
}

// ################# STARTUP #################

/**
 * Starts the Hue SSE listener: builds the UUID map (retrying with backoff on
 * failure) and then opens the SSE stream. Called from index.js; NOT started
 * in dry-run (see index.js's gating, same as the Insteon listener) since it
 * holds an open connection to real hardware.
 */
function startListener() {
    ensureInit();
    initUuidMapWithRetry();
}

/**
 * Test-only hook: clears all module-level connection/timer/map state so
 * tests don't leak state into each other. Never called from production code.
 */
function _resetForTesting() {
    uuidMap = new Map();
    trackedExtras.clear();
    sseBuffer = '';
    uuidMapRetryDelay = INITIAL_BACKOFF_MS;
    reconnectDelay = INITIAL_BACKOFF_MS;
    torndown = true;
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    stopFallbackPoll();
    sseRequest = null;
}

module.exports = {
    startListener,
    _init,
    _ingest,
    _handleBatch,
    _handleResourceItem,
    _buildUuidMapFromResource,
    _mapV1GroupState,
    _xyToHex,
    _resetForTesting,
};
