/**
 * Unit tests for src/lightingShelly.js's MQTT listener (startShellyListener /
 * _handleSwitchStatus / _handleOnline).
 *
 * Test-instrumentation approach: lightingShelly.js exports its subscribe
 * callbacks directly as `_handleSwitchStatus(topic, payload)` and
 * `_handleOnline(topic, payload)` (mirroring the `_init` escape hatch already
 * used by mqttTopics.js -- see its module doc comment). We call these
 * handlers directly instead of mocking mqttClient.subscribe, because
 * startShellyListener() only registers them with a plain `mqttClient.subscribe`
 * call -- there is no interesting dispatch/matching logic living in
 * lightingShelly.js itself (that logic already lives in, and is already
 * tested by, mqttClient's topicMatches). Testing the handlers directly is
 * simpler and avoids re-testing mqttClient's wildcard matching here.
 *
 * mqttTopics.js is wired to fixture lights via `_init({ lights, devices,
 * publish })`, exactly like test/mqttTopics.test.js, so requiring this file
 * never boots index.js. lightingShelly.js's own `require('../index')` (used
 * only by shelly_command's optimistic-state lookup) is not exercised by these
 * tests, since we only test the listener handlers here.
 *
 * No broker involved -- these are pure unit tests.
 */

const assert = require('node:assert');
const { test, beforeEach } = require('node:test');

const mqttTopics = require('../src/mqttTopics');
const { _handleSwitchStatus, _handleOnline } = require('../src/lightingShelly');

let published;

function fakePublish(topic, payload, opts) {
    published.push({ topic, payload, opts });
}

// Two Shellys in DIFFERENT locations sharing the same mqttName-style generic
// id ("plug"), to prove resolution is by FULL topic (location + ecosystem +
// mqttName), not by name alone -- same property findByTopic itself asserts.
const kitchenPlug = {
    id: 'kitchenPlug',
    type: 'shelly',
    address: '10.0.0.11',
    location: 'kitchen',
    mqttName: 'plug',
};

const garagePlug = {
    id: 'garagePlug',
    type: 'shelly',
    address: '10.0.0.12',
    location: 'garage',
    mqttName: 'plug',
};

// A Shelly with an explicit mqttName override (distinct from its id), per
// the config schema documented in mqtt-implementation-detail.md.
const artWall = {
    id: 'ledArtWallShelly',
    type: 'shelly',
    address: '10.0.0.13',
    location: 'living-room',
    mqttName: 'led-art-wall',
};

beforeEach(() => {
    published = [];
    mqttTopics._init({
        lights: [kitchenPlug, garagePlug, artWall],
        devices: [],
        publish: fakePublish,
    });
    // beforeEach resets fixture objects' mutable UI fields so tests don't
    // leak in-memory state into each other.
    for (const entry of [kitchenPlug, garagePlug, artWall]) {
        delete entry.checked;
        delete entry.status;
    }
});

// --- _handleSwitchStatus: output -> power, full-topic resolution ---

test('output:true resolves to ON and publishes canonical state', () => {
    const topic = 'apollo/kitchen/shelly/plug/status/switch:0';
    const payload = { id: 0, source: 'init', output: true, apower: 12.3 };

    _handleSwitchStatus(topic, payload);

    assert.strictEqual(published.length, 1);
    assert.strictEqual(published[0].topic, 'apollo/kitchen/shelly/plug/state');
    assert.strictEqual(published[0].payload.power, 'ON');
    assert.strictEqual(published[0].payload.source, 'event');
});

test('output:false resolves to OFF', () => {
    const topic = 'apollo/kitchen/shelly/plug/status/switch:0';
    _handleSwitchStatus(topic, { id: 0, source: 'WS_in', output: false });

    assert.strictEqual(published.length, 1);
    assert.strictEqual(published[0].payload.power, 'OFF');
});

test('resolves the correct entry by FULL topic when two devices share an mqttName in different locations', () => {
    _handleSwitchStatus('apollo/kitchen/shelly/plug/status/switch:0', { output: true });
    _handleSwitchStatus('apollo/garage/shelly/plug/status/switch:0', { output: false });

    assert.strictEqual(kitchenPlug.checked, true);
    assert.strictEqual(kitchenPlug.status, 100);
    assert.strictEqual(garagePlug.checked, false);
    assert.strictEqual(garagePlug.status, 0);

    assert.strictEqual(published.length, 2);
    assert.strictEqual(published[0].topic, 'apollo/kitchen/shelly/plug/state');
    assert.strictEqual(published[1].topic, 'apollo/garage/shelly/plug/state');
});

test('resolves a device with an explicit mqttName override', () => {
    const topic = 'apollo/living-room/shelly/led-art-wall/status/switch:0';
    _handleSwitchStatus(topic, {
        id: 0,
        source: 'init',
        output: false,
        apower: 0.0,
        voltage: 129.1,
        aenergy: { total: 104.997 },
        temperature: { tC: 48.8, tF: 119.8 },
    });

    assert.strictEqual(artWall.checked, false);
    assert.strictEqual(artWall.status, 0);
    assert.strictEqual(published[0].topic, 'apollo/living-room/shelly/led-art-wall/state');
    assert.strictEqual(published[0].payload.power, 'OFF');
});

test('updates the in-memory lights entry (checked/status) alongside the MQTT publish', () => {
    _handleSwitchStatus('apollo/kitchen/shelly/plug/status/switch:0', { output: true });
    assert.strictEqual(kitchenPlug.checked, true);
    assert.strictEqual(kitchenPlug.status, 100);

    _handleSwitchStatus('apollo/kitchen/shelly/plug/status/switch:0', { output: false });
    assert.strictEqual(kitchenPlug.checked, false);
    assert.strictEqual(kitchenPlug.status, 0);
});

// --- _handleSwitchStatus: malformed payloads / unknown devices ---

test('malformed payload (missing output) is ignored, not thrown', () => {
    assert.doesNotThrow(() => {
        _handleSwitchStatus('apollo/kitchen/shelly/plug/status/switch:0', { id: 0, source: 'init' });
    });
    assert.strictEqual(published.length, 0);
    assert.strictEqual(kitchenPlug.checked, undefined);
});

test('malformed payload (string instead of object) is ignored, not thrown', () => {
    assert.doesNotThrow(() => {
        _handleSwitchStatus('apollo/kitchen/shelly/plug/status/switch:0', 'not-an-object');
    });
    assert.strictEqual(published.length, 0);
});

test('malformed payload (null) is ignored, not thrown', () => {
    assert.doesNotThrow(() => {
        _handleSwitchStatus('apollo/kitchen/shelly/plug/status/switch:0', null);
    });
    assert.strictEqual(published.length, 0);
});

test('unknown device (no matching config entry) is logged, not thrown, and does not publish', () => {
    assert.doesNotThrow(() => {
        _handleSwitchStatus('apollo/attic/shelly/mystery/status/switch:0', { output: true });
    });
    assert.strictEqual(published.length, 0);
});

// --- _handleOnline: LWT handling ---

test('online:false marks the entry unreachable via publishUnreachable', () => {
    // Seed prior state so we can prove publishUnreachable preserves it.
    _handleSwitchStatus('apollo/kitchen/shelly/plug/status/switch:0', { output: true });
    published = [];

    _handleOnline('apollo/kitchen/shelly/plug/online', false);

    assert.strictEqual(published.length, 1);
    assert.strictEqual(published[0].topic, 'apollo/kitchen/shelly/plug/state');
    assert.strictEqual(published[0].payload.reachable, false);
    assert.strictEqual(published[0].payload.power, 'ON', 'prior power should be preserved by publishUnreachable\'s merge');
});

test('online:true is a no-op (a status/switch:0 message follows on its own)', () => {
    _handleOnline('apollo/kitchen/shelly/plug/online', true);
    assert.strictEqual(published.length, 0);
});

test('online payload is a plain boolean after JSON.parse, per real device payload shape', () => {
    // Real devices publish the bare string "false" (not JSON-quoted), which
    // mqttClient's JSON.parse turns into the boolean `false` before handlers
    // ever see it -- confirm the handler consumes that boolean form directly.
    assert.doesNotThrow(() => {
        _handleOnline('apollo/kitchen/shelly/plug/online', false);
    });
});

test('malformed online payload (not a boolean) is ignored, not thrown', () => {
    assert.doesNotThrow(() => {
        _handleOnline('apollo/kitchen/shelly/plug/online', { unexpected: 'shape' });
    });
    assert.strictEqual(published.length, 0);
});

test('online:false for an unknown device is logged, not thrown', () => {
    assert.doesNotThrow(() => {
        _handleOnline('apollo/attic/shelly/mystery/online', false);
    });
    assert.strictEqual(published.length, 0);
});
