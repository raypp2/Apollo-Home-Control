/**
 * Unit tests for src/mqttCommandListener.js (Stage 10 of the MQTT plan,
 * issue #23).
 *
 * Test-instrumentation approach: mqttCommandListener.js exposes
 * `_init({ subscribe, triggers, handleRequest, commandSource })` (mirroring
 * the override hook already used by mqttTopics.js/healthMonitor.js/
 * lightingInsteonListener.js) plus its subscribe callback directly as
 * `_handleDelta(topic, payload)` -- mirroring lightingShelly.test.js's
 * approach of calling the handler directly rather than going through
 * mqttClient's subscribe/dispatch machinery (already tested by
 * mqttClient.test.js).
 *
 * No broker involved -- these are pure unit tests.
 */

const assert = require('node:assert');
const util = require('node:util');
const { test, beforeEach } = require('node:test');

const { _init, _handleDelta } = require('../src/mqttCommandListener');

// --- Fixture triggers (mirrors real config/triggers.json shapes) ---

const DIMMABLE_LIGHT = {
    endpointId: 'kitchenLight',
    friendlyName: 'Kitchen Light',
    apiModule: 'LIGHTS',
    apiDevice: 'kitchenLight',
    isDimmable: true,
    statefulMqtt: true,
    location: 'kitchen',
    mqttName: 'kitchenLight',
};

const SHADES = {
    endpointId: 'shades',
    friendlyName: 'Blackout Shades',
    apiModule: 'DEVICES',
    apiDevice: 'shades',
    apiCommand: 'all',
    isPercentageController: true,
    statefulMqtt: true,
    location: 'living-room',
    mqttName: 'shades',
};

// A scene endpoint that exists in triggers.json but was never stamped
// statefulMqtt (alexaTriggers.js only stamps it for insteon/hue-group/shelly/
// Somfy-Bridge entries) -- the Lambda never dual-writes a shadow for this, so
// no delta should ever legitimately arrive for it, but the listener must
// still ignore one defensively rather than throw.
const SCENE = {
    endpointId: 'movieNight',
    friendlyName: 'Movie Night',
    apiModule: 'LIGHTINGSCENES',
    apiDevice: 'movieNight',
    location: 'home',
    mqttName: 'movieNight',
};

const FIXTURE_TRIGGERS = [DIMMABLE_LIGHT, SHADES, SCENE];

let calls;

function fakeHandleRequest(commandPath) {
    calls.push(commandPath);
}

function initWith(commandSource) {
    calls = [];
    _init({
        subscribe: () => {},
        triggers: FIXTURE_TRIGGERS,
        handleRequest: fakeHandleRequest,
        commandSource,
    });
}

beforeEach(() => {
    initWith('shadow'); // default to shadow mode so most tests observe execution directly
});

function deltaPayload(state, overrides) {
    return {
        version: 1,
        timestamp: Math.floor(Date.now() / 1000),
        state,
        metadata: {},
        ...overrides,
    };
}

// --- Command path construction ---

test('power ON delta on a dimmable light builds the exact LIGHTS on path', () => {
    _handleDelta('$aws/things/apollo-kitchenLight/shadow/update/delta', deltaPayload({ power: 'ON' }));
    assert.deepStrictEqual(calls, ['/LIGHTS/kitchenLight/on']);
});

test('power OFF delta builds the exact LIGHTS off path', () => {
    _handleDelta('$aws/things/apollo-kitchenLight/shadow/update/delta', deltaPayload({ power: 'OFF' }));
    assert.deepStrictEqual(calls, ['/LIGHTS/kitchenLight/off']);
});

test('brightness delta builds the numeric LIGHTS level path', () => {
    _handleDelta('$aws/things/apollo-kitchenLight/shadow/update/delta', deltaPayload({ brightness: 65 }));
    assert.deepStrictEqual(calls, ['/LIGHTS/kitchenLight/65']);
});

test('position delta on shades builds the DEVICES/shades/all percentage path', () => {
    _handleDelta('$aws/things/apollo-shades/shadow/update/delta', deltaPayload({ position: 40 }));
    assert.deepStrictEqual(calls, ['/DEVICES/shades/all/40']);
});

test('power ON delta on shades builds the DEVICES/shades/all/on path (trigger.apiCommand inserted)', () => {
    _handleDelta('$aws/things/apollo-shades/shadow/update/delta', deltaPayload({ power: 'ON' }));
    assert.deepStrictEqual(calls, ['/DEVICES/shades/all/on']);
});

test('multi-field delta executes power first, then brightness, in a single stable order', () => {
    _handleDelta(
        '$aws/things/apollo-kitchenLight/shadow/update/delta',
        deltaPayload({ brightness: 80, power: 'ON' }) // deliberately out of order in the object literal
    );
    assert.deepStrictEqual(calls, ['/LIGHTS/kitchenLight/on', '/LIGHTS/kitchenLight/80']);
});

// --- Version dedupe ---

test('a repeated delta at the same version executes only once', () => {
    const payload = deltaPayload({ power: 'ON' }, { version: 5 });
    _handleDelta('$aws/things/apollo-kitchenLight/shadow/update/delta', payload);
    _handleDelta('$aws/things/apollo-kitchenLight/shadow/update/delta', payload);
    assert.strictEqual(calls.length, 1);
});

test('a delta at a lower version than already processed is ignored', () => {
    _handleDelta('$aws/things/apollo-kitchenLight/shadow/update/delta', deltaPayload({ power: 'ON' }, { version: 6 }));
    assert.strictEqual(calls.length, 1);

    _handleDelta('$aws/things/apollo-kitchenLight/shadow/update/delta', deltaPayload({ power: 'OFF' }, { version: 5 }));
    assert.strictEqual(calls.length, 1, 'the lower-version delta must not execute');
});

test('a delta at a strictly higher version than already processed still executes', () => {
    _handleDelta('$aws/things/apollo-kitchenLight/shadow/update/delta', deltaPayload({ power: 'ON' }, { version: 1 }));
    _handleDelta('$aws/things/apollo-kitchenLight/shadow/update/delta', deltaPayload({ power: 'OFF' }, { version: 2 }));
    assert.deepStrictEqual(calls, ['/LIGHTS/kitchenLight/on', '/LIGHTS/kitchenLight/off']);
});

// --- Ignored endpoints ---

test('a non-statefulMqtt endpoint (exists in triggers, never stamped stateful) is ignored, not thrown', () => {
    assert.doesNotThrow(() => {
        _handleDelta('$aws/things/apollo-movieNight/shadow/update/delta', deltaPayload({ power: 'ON' }));
    });
    assert.strictEqual(calls.length, 0);
});

test('an unknown thing (endpointId absent from triggers entirely) is ignored, not thrown', () => {
    assert.doesNotThrow(() => {
        _handleDelta('$aws/things/apollo-doesNotExist/shadow/update/delta', deltaPayload({ power: 'ON' }));
    });
    assert.strictEqual(calls.length, 0);
});

test('a thing outside the apollo- namespace is ignored, not thrown', () => {
    assert.doesNotThrow(() => {
        _handleDelta('$aws/things/some-other-thing/shadow/update/delta', deltaPayload({ power: 'ON' }));
    });
    assert.strictEqual(calls.length, 0);
});

// --- Malformed payloads ---

test('a non-object payload (raw string, per mqttClient passthrough) does not throw and does not execute', () => {
    assert.doesNotThrow(() => {
        _handleDelta('$aws/things/apollo-kitchenLight/shadow/update/delta', 'not-json');
    });
    assert.strictEqual(calls.length, 0);
});

test('a payload missing state/version does not throw and does not execute', () => {
    assert.doesNotThrow(() => {
        _handleDelta('$aws/things/apollo-kitchenLight/shadow/update/delta', { metadata: {} });
    });
    assert.strictEqual(calls.length, 0);
});

test('a malformed field value (bad power string) is skipped but does not throw and does not crash other fields', () => {
    assert.doesNotThrow(() => {
        _handleDelta(
            '$aws/things/apollo-kitchenLight/shadow/update/delta',
            deltaPayload({ power: 'MAYBE', brightness: 50 })
        );
    });
    assert.deepStrictEqual(calls, ['/LIGHTS/kitchenLight/50']);
});

// --- COMMAND_SOURCE=sqs: log-only comparison mode ---

test('COMMAND_SOURCE=sqs: handleRequest is never called, but a SHADOW-CMD (log-only) comparison line is logged', () => {
    initWith('sqs');

    const logs = [];
    const originalLog = console.log;
    console.log = (...args) => logs.push(util.format(...args));

    try {
        _handleDelta('$aws/things/apollo-kitchenLight/shadow/update/delta', deltaPayload({ power: 'ON' }, { version: 9 }));
    } finally {
        console.log = originalLog;
    }

    assert.strictEqual(calls.length, 0, 'handleRequest must not be called in sqs mode');
    assert.ok(
        logs.some((l) => l.includes('SHADOW-CMD (log-only)') && l.includes('kitchenLight') && l.includes('version=9')),
        `expected a SHADOW-CMD (log-only) comparison line, got: ${JSON.stringify(logs)}`
    );
});

test('COMMAND_SOURCE=shadow: the comparison line is logged WITHOUT the "(log-only)" suffix', () => {
    const logs = [];
    const originalLog = console.log;
    console.log = (...args) => logs.push(util.format(...args));

    try {
        _handleDelta('$aws/things/apollo-kitchenLight/shadow/update/delta', deltaPayload({ power: 'ON' }, { version: 9 }));
    } finally {
        console.log = originalLog;
    }

    assert.strictEqual(calls.length, 1);
    assert.ok(logs.some((l) => l.startsWith('SHADOW-CMD:') && l.includes('kitchenLight')));
    assert.ok(!logs.some((l) => l.includes('(log-only)')));
});
