/**
 * Unit tests for src/mqttOrphanCleanup.js -- the live-incident hardening fix
 * that sweeps apollo/+/+/+/state at startup for retained topics no longer
 * backed by a config entry (e.g. a light/device removed from
 * lights.json/devices.json) and clears them so healthMonitor.js doesn't seed
 * a permanent ghost stale/degraded entry from their retained replay.
 *
 * Test-instrumentation approach: mirrors mqttTopics.js's/healthMonitor.js's
 * lazy-init pattern. mqttOrphanCleanup.js exposes `_init({ subscribe,
 * publish, lights, devices, collectionWindowMs })`; we call it with a fake
 * `subscribe` that just captures the handler (mirroring
 * healthMonitor.test.js's/mqttSetListener.test.js's "call the captured
 * handler directly to simulate delivery" approach), a fake `publish` spy, and
 * a short real `collectionWindowMs` (20ms) so the tests run fast with real
 * timers rather than a mocked clock -- same style as
 * lightingInsteonListener.test.js's `_setEventFollowUpPollDelayForTesting`.
 *
 * mqttOrphanCleanup.js reuses mqttTopics.js's own `topicFor()` to build the
 * known-good set, so these tests also call mqttTopics.js's own `_init({
 * lights, devices, publish })` first (exactly like
 * lightingInsteonListener.test.js does) so requiring/exercising either module
 * never boots index.js or touches a real broker.
 *
 * No broker involved -- these are pure unit tests.
 */

'use strict';

const assert = require('node:assert');
const { test, beforeEach } = require('node:test');

const mqttTopics = require('../src/mqttTopics');
const orphanCleanup = require('../src/mqttOrphanCleanup');

// Two live insteon lights (no location override -- default topic location
// "home", matching the config shape from the actual incident:
// apollo/home/insteon/christmasTree/state, apollo/home/insteon/bedroom/state).
const kitchen = { id: 'kitchen', type: 'insteon' };
const diningRoom = { id: 'diningRoom', type: 'insteon' };
const shades = { id: 'shades', type: 'Somfy-Bridge', location: 'bedroom', mqttName: 'shades' };

const KITCHEN_TOPIC = 'apollo/home/insteon/kitchen/state';
const CHRISTMAS_TREE_ORPHAN_TOPIC = 'apollo/home/insteon/christmasTree/state'; // removed from config -- the incident
const BEDROOM_ORPHAN_TOPIC = 'apollo/home/insteon/bedroom/state'; // removed from config -- the incident

const COLLECTION_WINDOW_MS = 20;

let publishCalls;
let capturedHandler;

function fakeSubscribe(filter, handler) {
    capturedHandler = handler;
}

function fakePublish(topic, payload, opts) {
    publishCalls.push({ topic, payload, opts });
}

function simulateDelivery(topic, retain) {
    capturedHandler(topic, {}, null, retain);
}

beforeEach(() => {
    publishCalls = [];
    capturedHandler = null;
    mqttTopics._init({ lights: [kitchen, diningRoom], devices: [shades], publish: () => {} });
    orphanCleanup._init({
        subscribe: fakeSubscribe,
        publish: fakePublish,
        lights: [kitchen, diningRoom],
        devices: [shades],
        collectionWindowMs: COLLECTION_WINDOW_MS,
    });
});

test('a retained topic matching a live config entry is not pruned', async () => {
    const sweep = orphanCleanup.cleanupOrphanedStateTopics();
    simulateDelivery(KITCHEN_TOPIC, true);
    await sweep;

    assert.strictEqual(publishCalls.length, 0);
});

test('a retained topic for a decommissioned device is pruned with an empty retained publish', async () => {
    const sweep = orphanCleanup.cleanupOrphanedStateTopics();
    simulateDelivery(CHRISTMAS_TREE_ORPHAN_TOPIC, true);
    await sweep;

    assert.strictEqual(publishCalls.length, 1);
    assert.strictEqual(publishCalls[0].topic, CHRISTMAS_TREE_ORPHAN_TOPIC);
    assert.strictEqual(publishCalls[0].payload, '');
    assert.deepStrictEqual(publishCalls[0].opts, { qos: 1, retain: true });
});

test('a non-retained message during the window for an unknown topic is not pruned', async () => {
    const sweep = orphanCleanup.cleanupOrphanedStateTopics();
    simulateDelivery(CHRISTMAS_TREE_ORPHAN_TOPIC, false); // fresh event, not a retained replay
    await sweep;

    assert.strictEqual(publishCalls.length, 0);
});

test('multiple orphans are each pruned exactly once and each logged', async () => {
    const originalLog = console.log;
    const logLines = [];
    console.log = (...args) => logLines.push(args.join(' '));

    try {
        const sweep = orphanCleanup.cleanupOrphanedStateTopics();
        simulateDelivery(CHRISTMAS_TREE_ORPHAN_TOPIC, true);
        simulateDelivery(BEDROOM_ORPHAN_TOPIC, true);
        simulateDelivery(CHRISTMAS_TREE_ORPHAN_TOPIC, true); // duplicate retained delivery -- still just one prune
        await sweep;
    } finally {
        console.log = originalLog;
    }

    assert.strictEqual(publishCalls.length, 2);
    const prunedTopics = publishCalls.map((c) => c.topic).sort();
    assert.deepStrictEqual(prunedTopics, [BEDROOM_ORPHAN_TOPIC, CHRISTMAS_TREE_ORPHAN_TOPIC].sort());

    const prunedLogLines = logLines.filter((line) => line.includes('pruned retained state for decommissioned device'));
    assert.strictEqual(prunedLogLines.length, 2, 'each orphan should log its own pruned-topic line');
});

test('zero orphans: publish is never called and exactly one quiet log line is emitted', async () => {
    const originalLog = console.log;
    const logLines = [];
    console.log = (...args) => logLines.push(args.join(' '));

    try {
        const sweep = orphanCleanup.cleanupOrphanedStateTopics();
        simulateDelivery(KITCHEN_TOPIC, true); // matches config -- not an orphan
        await sweep;
    } finally {
        console.log = originalLog;
    }

    assert.strictEqual(publishCalls.length, 0);
    const cleanupLines = logLines.filter((line) => line.includes('Orphan topic cleanup'));
    assert.strictEqual(cleanupLines.length, 1, 'exactly one summary line, no per-topic noise, when healthy');
    assert.ok(cleanupLines[0].includes('0 orphaned topics found'));
});

test('a missing/malformed lights and devices array does not throw and treats everything collected as an orphan', async () => {
    orphanCleanup._init({
        subscribe: fakeSubscribe,
        publish: fakePublish,
        lights: undefined,
        devices: null,
        collectionWindowMs: COLLECTION_WINDOW_MS,
    });

    await assert.doesNotReject(async () => {
        const sweep = orphanCleanup.cleanupOrphanedStateTopics();
        simulateDelivery(CHRISTMAS_TREE_ORPHAN_TOPIC, true);
        await sweep;
    });

    assert.strictEqual(publishCalls.length, 1);
    assert.strictEqual(publishCalls[0].topic, CHRISTMAS_TREE_ORPHAN_TOPIC);
});

test('a publish failure for one orphan does not prevent pruning the others and does not reject the returned promise', async () => {
    let publishAttempts = 0;
    orphanCleanup._init({
        subscribe: fakeSubscribe,
        publish: (topic, payload, opts) => {
            publishAttempts++;
            if (topic === CHRISTMAS_TREE_ORPHAN_TOPIC) {
                throw new Error('broker unreachable');
            }
            publishCalls.push({ topic, payload, opts });
        },
        lights: [kitchen, diningRoom],
        devices: [shades],
        collectionWindowMs: COLLECTION_WINDOW_MS,
    });

    const sweep = orphanCleanup.cleanupOrphanedStateTopics();
    simulateDelivery(CHRISTMAS_TREE_ORPHAN_TOPIC, true); // this one throws on publish
    simulateDelivery(BEDROOM_ORPHAN_TOPIC, true); // this one must still succeed

    await assert.doesNotReject(sweep);

    assert.strictEqual(publishAttempts, 2, 'both orphans should have had a publish attempted');
    assert.strictEqual(publishCalls.length, 1, 'only the non-throwing publish should have recorded a successful call');
    assert.strictEqual(publishCalls[0].topic, BEDROOM_ORPHAN_TOPIC);
});
