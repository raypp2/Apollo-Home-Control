/**
 * Unit tests for src/somfyBridge.js's MQTT listener (startSomfyListener /
 * _handlePosition / _handleBridgeStatus).
 *
 * Test-instrumentation approach: somfyBridge.js exports its subscribe
 * callbacks directly as `_handlePosition(topic, payload)` and
 * `_handleBridgeStatus(topic, payload)`, mirroring lightingShelly.js's
 * `_handleSwitchStatus` / `_handleOnline` pattern (see that module's test
 * file for the rationale -- there is no interesting dispatch/matching logic
 * living in somfyBridge.js itself; that already lives in, and is already
 * tested by, mqttClient's topicMatches).
 *
 * mqttTopics.js is wired to fixture devices via `_init({ lights, devices,
 * publish })`, exactly like test/mqttTopics.test.js and
 * test/lightingShelly.test.js, so requiring this file never boots index.js.
 * somfyBridge.js's own `require('../index')` (used only by
 * send_somfy_command's optimistic-state lookup) is not exercised by these
 * tests, since we only test the listener handlers here.
 *
 * No broker involved -- these are pure unit tests.
 */

const assert = require('node:assert');
const { test, beforeEach } = require('node:test');

const mqttTopics = require('../src/mqttTopics');
const { _handlePosition, _handleBridgeStatus } = require('../src/somfyBridge');

let published;

function fakePublish(topic, payload, opts) {
    published.push({ topic, payload, opts });
}

// The real config entry: devices.json's single "shades" entry, location
// "living-room", no mqttName override (falls back to id "shades") -- its
// canonical topic is `apollo/living-room/somfy/shades/state`, which aligns
// EXACTLY with the bridge's native `<root>/shades/...` prefix.
const shades = {
    id: 'shades',
    type: 'Somfy-Bridge',
    address: '192.168.20.13',
    location: 'living-room',
};

// A decoy entry in a different location/ecosystem to prove resolution is by
// FULL topic prefix, not by name or type alone.
const kitchenPlug = {
    id: 'kitchenPlug',
    type: 'shelly',
    address: '10.0.0.11',
    location: 'kitchen',
    mqttName: 'plug',
};

beforeEach(() => {
    published = [];
    mqttTopics._init({
        lights: [kitchenPlug],
        devices: [shades],
        publish: fakePublish,
    });
});

// --- _handlePosition: shade 4 (tracked) ---

test('position on shade 4 resolves via prefix and publishes canonical state', () => {
    const topic = 'apollo/living-room/somfy/shades/4/position';

    _handlePosition(topic, 55);

    assert.strictEqual(published.length, 1);
    assert.strictEqual(published[0].topic, 'apollo/living-room/somfy/shades/state');
    assert.strictEqual(published[0].payload.position, 55);
    assert.strictEqual(published[0].payload.source, 'event');
});

test('position 0 (open/up) and 100 (closed/down) are both valid boundary values', () => {
    _handlePosition('apollo/living-room/somfy/shades/4/position', 0);
    assert.strictEqual(published[0].payload.position, 0);

    _handlePosition('apollo/living-room/somfy/shades/4/position', 100);
    assert.strictEqual(published[1].payload.position, 100);
});

// --- _handlePosition: shades 1-3 (untracked) ---

test('shade 1 position is ignored (no publish)', () => {
    _handlePosition('apollo/living-room/somfy/shades/1/position', 42);
    assert.strictEqual(published.length, 0);
});

test('shade 2 position is ignored (no publish)', () => {
    _handlePosition('apollo/living-room/somfy/shades/2/position', 42);
    assert.strictEqual(published.length, 0);
});

test('shade 3 position is ignored (no publish)', () => {
    _handlePosition('apollo/living-room/somfy/shades/3/position', 42);
    assert.strictEqual(published.length, 0);
});

// --- _handlePosition: malformed payloads ---

test('non-numeric payload is ignored, not thrown', () => {
    assert.doesNotThrow(() => {
        _handlePosition('apollo/living-room/somfy/shades/4/position', 'not-a-number');
    });
    assert.strictEqual(published.length, 0);
});

test('object payload is ignored, not thrown', () => {
    assert.doesNotThrow(() => {
        _handlePosition('apollo/living-room/somfy/shades/4/position', { unexpected: 'shape' });
    });
    assert.strictEqual(published.length, 0);
});

test('null payload is ignored, not thrown', () => {
    assert.doesNotThrow(() => {
        _handlePosition('apollo/living-room/somfy/shades/4/position', null);
    });
    assert.strictEqual(published.length, 0);
});

test('out-of-range payload (negative) is ignored, not thrown', () => {
    assert.doesNotThrow(() => {
        _handlePosition('apollo/living-room/somfy/shades/4/position', -1);
    });
    assert.strictEqual(published.length, 0);
});

test('out-of-range payload (>100) is ignored, not thrown', () => {
    assert.doesNotThrow(() => {
        _handlePosition('apollo/living-room/somfy/shades/4/position', 101);
    });
    assert.strictEqual(published.length, 0);
});

// --- _handlePosition: unknown location / no config entry ---

test('unknown location (no matching config entry) is logged, not thrown, and does not publish', () => {
    assert.doesNotThrow(() => {
        _handlePosition('apollo/attic/somfy/shades/4/position', 50);
    });
    assert.strictEqual(published.length, 0);
});

// --- _handleBridgeStatus: bridge-level LWT ---

test('status "offline" marks the shades entry unreachable via publishUnreachable', () => {
    // Seed prior state so we can prove publishUnreachable preserves it.
    _handlePosition('apollo/living-room/somfy/shades/4/position', 30);
    published = [];

    _handleBridgeStatus('apollo/living-room/somfy/status', 'offline');

    assert.strictEqual(published.length, 1);
    assert.strictEqual(published[0].topic, 'apollo/living-room/somfy/shades/state');
    assert.strictEqual(published[0].payload.reachable, false);
    assert.strictEqual(published[0].payload.position, 30, 'prior position should be preserved by publishUnreachable\'s merge');
});

test('status "online" is a no-op (per-shade position messages follow on their own)', () => {
    _handleBridgeStatus('apollo/living-room/somfy/status', 'online');
    assert.strictEqual(published.length, 0);
});

test('unrecognized status payload is ignored, not thrown', () => {
    assert.doesNotThrow(() => {
        _handleBridgeStatus('apollo/living-room/somfy/status', { unexpected: 'shape' });
    });
    assert.strictEqual(published.length, 0);
});

test('status "offline" for an unknown location is logged, not thrown', () => {
    assert.doesNotThrow(() => {
        _handleBridgeStatus('apollo/attic/somfy/status', 'offline');
    });
    assert.strictEqual(published.length, 0);
});
