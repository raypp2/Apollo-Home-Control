/**
 * Apollo Home Control Bridge - MQTT Client
 * @module mqttClient.js
 *
 * @description  Thin wrapper over the `mqtt` package (v5.x) providing a single
 *               broker connection shared by the rest of Apollo. This module must
 *               NOT require('../index') -- it only reads env vars, so it is safe
 *               to require from anywhere (including before index.js has finished
 *               loading config).
 *
 *               Public API:
 *                 connect()                      - idempotent, call once from index.js
 *                 publish(topic, payload, opts)  - opts default { qos: 1, retain: false }
 *                 subscribe(topicFilter, handler) - handler(topic, payload, raw)
 *                 isConnected()
 *                 topicMatches(filter, topic)    - exported for tests
 *
 *               connect() is non-blocking: mqtt.js queues outgoing publishes while
 *               offline and reconnects on its own (reconnectPeriod), so Apollo starts
 *               and serves HTTP fine even if the broker is down.
 */

const mqtt = require('mqtt');

const STATUS_TOPIC = 'apollo/bridge/apollo/status';

let client = null;

// Registry of {filter, handler} pairs, replayed on every 'connect' event
// (including the first) so subscriptions survive broker restarts.
const subscriptions = [];

// Tracks whether we're currently considered connected, so we only log
// state TRANSITIONS (connect / offline / reconnecting once) rather than
// flooding apollo.log with a line per reconnect attempt.
let wasConnected = false;
let loggedReconnecting = false;
let lastErrorKey = null;

/**
 * Matches an MQTT topic against a filter that may contain '+' (single-level
 * wildcard) and '#' (multi-level wildcard, only valid as the last segment).
 * @param {string} filter
 * @param {string} topic
 * @returns {boolean}
 */
function topicMatches(filter, topic) {
    const filterParts = filter.split('/');
    const topicParts = topic.split('/');

    for (let i = 0; i < filterParts.length; i++) {
        const f = filterParts[i];

        if (f === '#') {
            // '#' must be the last filter segment and matches everything remaining
            // (including zero remaining segments).
            return true;
        }

        if (i >= topicParts.length) {
            // Filter has more segments than the topic and it wasn't a trailing '#'.
            return false;
        }

        if (f === '+') {
            continue;
        }

        if (f !== topicParts[i]) {
            return false;
        }
    }

    // No '#' consumed the rest -- lengths must match exactly.
    return filterParts.length === topicParts.length;
}

/**
 * Idempotent. Connects to the broker and wires up logging, LWT, and the
 * subscription registry replay. Safe to call multiple times -- subsequent
 * calls are a no-op.
 */
function connect() {
    if (client) {
        return client;
    }

    const brokerUrl = process.env.MQTT_BROKER_URL || 'mqtt://localhost:1883';

    client = mqtt.connect(brokerUrl, {
        will: {
            topic: STATUS_TOPIC,
            payload: 'offline',
            retain: true,
            qos: 1,
        },
        reconnectPeriod: 5000,
    });

    client.on('connect', () => {
        wasConnected = true;
        loggedReconnecting = false;
        lastErrorKey = null;
        console.log('MQTT: connected to %s', brokerUrl);

        // Re-subscribe everything registered so far (survives reconnects).
        for (const { filter } of subscriptions) {
            client.subscribe(filter, { qos: 1 }, (err) => {
                if (err) {
                    console.log('MQTT: failed to subscribe to %s: %s', filter, err.message);
                }
            });
        }

        publish(STATUS_TOPIC, 'online', { qos: 1, retain: true });
    });

    client.on('reconnect', () => {
        if (!loggedReconnecting) {
            loggedReconnecting = true;
            console.log('MQTT: reconnecting to %s...', brokerUrl);
        }
    });

    client.on('offline', () => {
        if (wasConnected) {
            wasConnected = false;
            console.log('MQTT: offline (broker unreachable)');
        }
    });

    client.on('error', (err) => {
        // Log each distinct error once, not once per 5s reconnect attempt --
        // a broker outage must not flood apollo.log (transitions-only rule).
        const errorKey = err.code || err.message || String(err);
        if (errorKey !== lastErrorKey) {
            lastErrorKey = errorKey;
            console.log('MQTT: connection error: %s (suppressing repeats)', err.message || err.code || err);
        }
    });

    client.on('message', (topic, messageBuffer) => {
        const raw = messageBuffer.toString();
        let payload = raw;
        try {
            payload = JSON.parse(raw);
        } catch {
            // Plain-string payloads ("online", "offline", "stale") are a normal,
            // expected shape on status topics -- handlers receive them as the raw
            // string. Only payloads that LOOK like attempted JSON (start with
            // '{' or '[') get logged as parse failures; anything else passes
            // through silently. Nothing here can throw.
            const trimmed = raw.trimStart();
            if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
                console.log(
                    'MQTT: malformed JSON payload on %s (first 100 chars): %s',
                    topic,
                    raw.slice(0, 100)
                );
            }
        }

        for (const { filter, handler } of subscriptions) {
            if (topicMatches(filter, topic)) {
                try {
                    handler(topic, payload, messageBuffer);
                } catch (err) {
                    console.log('MQTT: handler for %s threw: %s', filter, err.message);
                }
            }
        }
    });

    return client;
}

/**
 * Publishes a message. Objects are JSON.stringify'd; strings pass through as-is.
 * @param {string} topic
 * @param {object|string} payload
 * @param {object} [opts] - default { qos: 1, retain: false }
 */
function publish(topic, payload, opts) {
    if (!client) {
        console.log('MQTT: publish called before connect() -- ignoring (%s)', topic);
        return;
    }

    const message = (typeof payload === 'string') ? payload : JSON.stringify(payload);
    const options = { qos: 1, retain: false, ...opts };

    client.publish(topic, message, options, (err) => {
        if (err) {
            console.log('MQTT: publish to %s failed: %s', topic, err.message);
        }
    });
}

/**
 * Registers a handler for a topic filter (supports '+' and '#'). The handler
 * receives (topic, payload, rawBuffer) where payload is JSON.parse'd when
 * possible; non-JSON payloads (e.g. plain "online"/"offline" strings) are
 * logged (topic + first 100 chars) and passed through as the raw string --
 * see the comment in the 'message' listener in connect() for why. A handler
 * that throws is caught and logged; it can never crash the process or starve
 * other handlers for the same message.
 * @param {string} topicFilter
 * @param {function(string, *, Buffer): void} handler
 */
function subscribe(topicFilter, handler) {
    subscriptions.push({ filter: topicFilter, handler });

    if (client && client.connected) {
        client.subscribe(topicFilter, { qos: 1 }, (err) => {
            if (err) {
                console.log('MQTT: failed to subscribe to %s: %s', topicFilter, err.message);
            }
        });
    }
}

function isConnected() {
    return !!(client && client.connected);
}

module.exports = {
    connect,
    publish,
    subscribe,
    isConnected,
    topicMatches,
};
