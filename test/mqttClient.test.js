/**
 * Tests for src/mqttClient.js.
 *
 * - topicMatches: pure unit tests, no broker.
 * - publish/subscribe/connect: integration tests against a real broker at
 *   mqtt://localhost:1883 (or MQTT_BROKER_URL). These probe the broker first
 *   and skip (logging a visible "SKIPPED (no broker)" message) rather than
 *   failing, per the plan's testing conventions -- CI-ready but not
 *   CI-dependent.
 */

const assert = require('node:assert');
const net = require('node:net');
const { test, before, after } = require('node:test');

const { topicMatches } = require('../src/mqttClient');

// --- topicMatches: exhaustive unit tests, no broker ---

test('topicMatches: exact match', () => {
    assert.strictEqual(topicMatches('apollo/home/insteon/kitchen/state', 'apollo/home/insteon/kitchen/state'), true);
});

test('topicMatches: exact non-match (different last segment)', () => {
    assert.strictEqual(topicMatches('apollo/home/insteon/kitchen/state', 'apollo/home/insteon/kitchen/set'), false);
});

test('topicMatches: single-level wildcard "+" matches one segment', () => {
    assert.strictEqual(topicMatches('apollo/+/insteon/kitchen/state', 'apollo/home/insteon/kitchen/state'), true);
});

test('topicMatches: "+" does not match across multiple segments', () => {
    assert.strictEqual(topicMatches('apollo/+/state', 'apollo/home/insteon/state'), false);
});

test('topicMatches: multiple "+" wildcards', () => {
    assert.strictEqual(topicMatches('apollo/+/+/+/state', 'apollo/home/insteon/kitchen/state'), true);
    assert.strictEqual(topicMatches('apollo/+/+/+/state', 'apollo/home/insteon/kitchen/set'), false);
});

test('topicMatches: "#" at the end matches everything remaining', () => {
    assert.strictEqual(topicMatches('apollo/#', 'apollo/home/insteon/kitchen/state'), true);
    assert.strictEqual(topicMatches('apollo/home/#', 'apollo/home/insteon/kitchen/state'), true);
    assert.strictEqual(topicMatches('apollo/other/#', 'apollo/home/insteon/kitchen/state'), false);
});

test('topicMatches: "#" alone matches everything', () => {
    assert.strictEqual(topicMatches('#', 'apollo/home/insteon/kitchen/state'), true);
});

test('topicMatches: "#" matches zero remaining segments (the topic ending exactly where # begins)', () => {
    assert.strictEqual(topicMatches('apollo/home/#', 'apollo/home'), true);
});

test('topicMatches: combined "+" and "#"', () => {
    assert.strictEqual(topicMatches('apollo/+/insteon/#', 'apollo/home/insteon/kitchen/state'), true);
    assert.strictEqual(topicMatches('apollo/+/hue/#', 'apollo/home/insteon/kitchen/state'), false);
});

test('topicMatches: filter longer than topic does not match', () => {
    assert.strictEqual(topicMatches('apollo/home/insteon/kitchen/state/extra', 'apollo/home/insteon/kitchen/state'), false);
});

test('topicMatches: topic longer than filter (no trailing #) does not match', () => {
    assert.strictEqual(topicMatches('apollo/home/insteon', 'apollo/home/insteon/kitchen/state'), false);
});

test('topicMatches: status topic wildcard', () => {
    assert.strictEqual(topicMatches('apollo/+/+/+/status', 'apollo/theater/itach/projector/status'), true);
});

test('topicMatches: health wildcard subscription', () => {
    assert.strictEqual(topicMatches('apollo/health/#', 'apollo/health/summary'), true);
    assert.strictEqual(topicMatches('apollo/health/#', 'apollo/home/insteon/kitchen/state'), false);
});

// --- Integration tests: probe the broker first, skip gracefully if down ---

const BROKER_URL = process.env.MQTT_BROKER_URL || 'mqtt://localhost:1883';
const BROKER_HOST = 'localhost';
const BROKER_PORT = 1883;

function probeBroker(host, port, timeoutMs = 1000) {
    return new Promise((resolve) => {
        const socket = net.createConnection({ host, port });
        const timer = setTimeout(() => {
            socket.destroy();
            resolve(false);
        }, timeoutMs);

        socket.on('connect', () => {
            clearTimeout(timer);
            socket.end();
            resolve(true);
        });

        socket.on('error', () => {
            clearTimeout(timer);
            resolve(false);
        });
    });
}

let brokerAvailable = false;

before(async () => {
    brokerAvailable = await probeBroker(BROKER_HOST, BROKER_PORT);
    if (!brokerAvailable) {
        console.log(`SKIPPED (no broker) -- nothing listening on ${BROKER_HOST}:${BROKER_PORT}`);
    }
});

// Each integration test uses its own short-lived mqtt.js client (independent
// of src/mqttClient.js's module-level singleton) so tests don't interfere
// with each other or with any other process's connection to the broker.
const mqtt = require('mqtt');

function connectClient(opts) {
    return new Promise((resolve, reject) => {
        const client = mqtt.connect(BROKER_URL, { reconnectPeriod: 0, ...opts });
        client.on('connect', () => resolve(client));
        client.on('error', (err) => reject(err));
    });
}

test('integration: publish/subscribe round-trip', async (t) => {
    if (!brokerAvailable) {
        t.skip('SKIPPED (no broker)');
        return;
    }

    const topic = `apollo/test/mqttClient/${Date.now()}/state`;
    const client = await connectClient({});

    try {
        const received = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('timed out waiting for message')), 3000);
            client.subscribe(topic, { qos: 1 }, (err) => {
                if (err) reject(err);
            });
            client.on('message', (t2, payload) => {
                clearTimeout(timer);
                resolve(payload.toString());
            });
            client.publish(topic, JSON.stringify({ power: 'ON' }), { qos: 1 });
        });

        assert.deepStrictEqual(JSON.parse(received), { power: 'ON' });
    } finally {
        client.end(true);
    }
});

test('integration: retained message is received on late subscribe', async (t) => {
    if (!brokerAvailable) {
        t.skip('SKIPPED (no broker)');
        return;
    }

    const topic = `apollo/test/mqttClient/${Date.now()}/retained`;
    const publisher = await connectClient({});

    try {
        await new Promise((resolve, reject) => {
            publisher.publish(topic, JSON.stringify({ reachable: true }), { qos: 1, retain: true }, (err) => {
                if (err) reject(err); else resolve();
            });
        });

        const subscriber = await connectClient({});
        try {
            const received = await new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('timed out waiting for retained message')), 3000);
                subscriber.on('message', (t2, payload) => {
                    clearTimeout(timer);
                    resolve(payload.toString());
                });
                subscriber.subscribe(topic, { qos: 1 });
            });

            assert.deepStrictEqual(JSON.parse(received), { reachable: true });
        } finally {
            subscriber.end(true);
        }
    } finally {
        // Clean up the retained message so it doesn't linger on the broker.
        await new Promise((resolve) => publisher.publish(topic, '', { retain: true }, () => resolve()));
        publisher.end(true);
    }
});

test('integration: JSON payload round-trips through JSON.parse', async (t) => {
    if (!brokerAvailable) {
        t.skip('SKIPPED (no broker)');
        return;
    }

    const topic = `apollo/test/mqttClient/${Date.now()}/json`;
    const client = await connectClient({});

    try {
        const received = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('timed out')), 3000);
            client.subscribe(topic, { qos: 1 }, (err) => {
                if (err) reject(err);
            });
            client.on('message', (t2, payload) => {
                clearTimeout(timer);
                resolve(payload.toString());
            });
            client.publish(topic, JSON.stringify({ power: 'ON', brightness: 42 }), { qos: 1 });
        });

        assert.deepStrictEqual(JSON.parse(received), { power: 'ON', brightness: 42 });
    } finally {
        client.end(true);
    }
});

test('integration: non-JSON payload arrives as plain string', async (t) => {
    if (!brokerAvailable) {
        t.skip('SKIPPED (no broker)');
        return;
    }

    const topic = `apollo/test/mqttClient/${Date.now()}/status`;
    const client = await connectClient({});

    try {
        const received = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('timed out')), 3000);
            client.subscribe(topic, { qos: 1 }, (err) => {
                if (err) reject(err);
            });
            client.on('message', (t2, payload) => {
                clearTimeout(timer);
                resolve(payload.toString());
            });
            client.publish(topic, 'online', { qos: 1 });
        });

        assert.strictEqual(received, 'online');
        assert.throws(() => JSON.parse(received));
    } finally {
        client.end(true);
    }
});

after(() => {
    // No shared client to close -- each integration test cleans up its own.
});
