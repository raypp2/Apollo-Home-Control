/**
 * Unit tests for src/alexaTriggers.js.
 *
 * alexaTriggers.js requires('../index') at module load time (same pattern as
 * every other src/ module) -- that's unavoidable to test directly without
 * booting the whole config-loading chain. What IS testable in isolation is
 * the pure `buildTriggersArray(configs)` function, which takes injected
 * fixture config arrays and returns the triggers array without touching the
 * filesystem. These tests exercise that function directly, focused on the
 * `statefulMqtt` flag stamping added in Stage 7: index-0-only, and gated by
 * mqttTopics.isAlexaStateful() (alexa config + a type that actually publishes
 * MQTT state).
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const util = require('node:util');
const { test } = require('node:test');

const { buildTriggersArray } = require('../src/alexaTriggers');

const EMPTY_CONFIGS = { devices: [], deviceScenes: [], lights: [], lightingScenes: [], macros: [] };

test('lights: a stateful-type light (insteon) with alexa config gets statefulMqtt:true on its first invocation', () => {
    const kitchen = {
        id: 'kitchen',
        type: 'insteon',
        alexa: { invocations: ['Kitchen', 'Kitchen Light'], displayCategories: ['LIGHT'], isDimmable: true },
    };
    const triggers = buildTriggersArray({ ...EMPTY_CONFIGS, lights: [kitchen] });

    assert.strictEqual(triggers.length, 2);
    assert.strictEqual(triggers[0].endpointId, 'kitchen');
    assert.strictEqual(triggers[0].statefulMqtt, true);
});

test('lights: alias endpoints (index > 0) never get statefulMqtt, even for a stateful-type light', () => {
    const kitchen = {
        id: 'kitchen',
        type: 'insteon',
        alexa: { invocations: ['Kitchen', 'Kitchen Light'], displayCategories: ['LIGHT'], isDimmable: true },
    };
    const triggers = buildTriggersArray({ ...EMPTY_CONFIGS, lights: [kitchen] });

    const alias = triggers[1];
    assert.strictEqual(alias.endpointId, 'kitchen-2');
    assert.strictEqual('statefulMqtt' in alias, false, 'alias endpoints should stay stateless');
});

test('lights: a DMX light (not a state-publishing type) gets NO statefulMqtt flag even with alexa config', () => {
    const ceiling = {
        id: 'ceiling',
        type: 'dmxFixture',
        alexa: { invocations: ['Ceiling'], displayCategories: ['SCENE_TRIGGER'], isDimmable: true },
    };
    const triggers = buildTriggersArray({ ...EMPTY_CONFIGS, lights: [ceiling] });

    assert.strictEqual(triggers.length, 1);
    assert.strictEqual('statefulMqtt' in triggers[0], false);
});

test('lights: a WLED light gets NO statefulMqtt flag even with alexa config', () => {
    const strips = {
        id: 'strips',
        type: 'wled',
        alexa: { invocations: ['Strips'], displayCategories: ['LIGHT'], isDimmable: true },
    };
    const triggers = buildTriggersArray({ ...EMPTY_CONFIGS, lights: [strips] });

    assert.strictEqual('statefulMqtt' in triggers[0], false);
});

test('lights: a hue-group light with alexa config gets statefulMqtt:true', () => {
    const giantP = {
        id: 'giantP',
        type: 'hue-group',
        alexa: { invocations: ['Giant P'], displayCategories: ['LIGHT'], isDimmable: true },
    };
    const triggers = buildTriggersArray({ ...EMPTY_CONFIGS, lights: [giantP] });

    assert.strictEqual(triggers[0].statefulMqtt, true);
});

test('lights: an insteon light without an alexa block is skipped entirely (no trigger, so nothing to flag)', () => {
    const noAlexa = { id: 'skipped', type: 'insteon' };
    const triggers = buildTriggersArray({ ...EMPTY_CONFIGS, lights: [noAlexa] });

    assert.strictEqual(triggers.length, 0);
});

test('devices: a stateful-type device (Somfy-Bridge shades) gets statefulMqtt:true on its first invocation only', () => {
    const shades = {
        id: 'shades',
        type: 'Somfy-Bridge',
        alexa: {
            invocations: ['Blackout Shades', 'Blackout Shade 1', 'Blackout Shade 2'],
            displayCategories: ['EXTERIOR_BLIND'],
            apiCommand: ['all', 'one', 'two'],
        },
    };
    const triggers = buildTriggersArray({ ...EMPTY_CONFIGS, devices: [shades] });

    assert.strictEqual(triggers.length, 3);
    assert.strictEqual(triggers[0].endpointId, 'shades');
    assert.strictEqual(triggers[0].statefulMqtt, true);

    assert.strictEqual(triggers[1].endpointId, 'shades-2');
    assert.strictEqual('statefulMqtt' in triggers[1], false, 'alias endpoints stay stateless');
    assert.strictEqual(triggers[2].endpointId, 'shades-3');
    assert.strictEqual('statefulMqtt' in triggers[2], false);
});

test('devices: an iTach_ir device (not a state-publishing type) gets NO statefulMqtt flag', () => {
    const ac = {
        id: 'livingRoomAC',
        type: 'iTach_ir',
        alexa: { invocations: ['Living Room AC'], displayCategories: ['THERMOSTAT'], isAC: true },
    };
    const triggers = buildTriggersArray({ ...EMPTY_CONFIGS, devices: [ac] });

    assert.strictEqual('statefulMqtt' in triggers[0], false);
});

test('devices: a device without an alexa block produces no trigger at all', () => {
    const noAlexa = { id: 'skipped', type: 'Somfy-Bridge' };
    const triggers = buildTriggersArray({ ...EMPTY_CONFIGS, devices: [noAlexa] });

    assert.strictEqual(triggers.length, 0);
});

test('lightingScenes, macros, and deviceScenes never get a statefulMqtt flag (scenes/macros are stateless by design)', () => {
    const scene = { id: 'movieNight', alexa: { invocations: ['Movie Night'], displayCategories: ['SCENE_TRIGGER'] } };
    const macro = { id: 'goodnight', alexa: { invocations: ['Goodnight'], displayCategories: ['SCENE_TRIGGER'] } };
    const deviceScene = { id: 'allOff', alexa: { invocations: ['All Off'], displayCategories: ['SCENE_TRIGGER'] } };

    const triggers = buildTriggersArray({
        ...EMPTY_CONFIGS,
        lightingScenes: [scene],
        macros: [macro],
        deviceScenes: [deviceScene],
    });

    assert.strictEqual(triggers.length, 3);
    for (const trigger of triggers) {
        assert.strictEqual('statefulMqtt' in trigger, false);
    }
});

// --- buildTriggers(): the fs-writing wrapper (startup-race regression) ---
//
// buildTriggers() requires('../index') at call time -- see the doc comment on
// that function -- so exercising it for real would boot Apollo's whole
// config-loading chain (webServer, SQS listener, MQTT client, ...), which is
// exactly what this file's other tests avoid by testing the pure
// buildTriggersArray() instead. To test the fs-writing behavior in isolation,
// these tests pre-seed require.cache for the resolved '../index' path with a
// minimal fixture module before calling buildTriggers(), and restore the
// original cache entry (and, for the first test, the original
// config/triggers.json content) afterward.

const INDEX_PATH = require.resolve('../index');
const TRIGGERS_JSON_PATH = path.join(__dirname, '..', 'config', 'triggers.json');

function withFakeIndexExports(fakeExports, fn) {
    const hadCachedIndex = Object.prototype.hasOwnProperty.call(require.cache, INDEX_PATH);
    const originalCachedIndex = require.cache[INDEX_PATH];
    require.cache[INDEX_PATH] = { id: INDEX_PATH, filename: INDEX_PATH, loaded: true, exports: fakeExports };
    try {
        fn();
    } finally {
        if (hadCachedIndex) {
            require.cache[INDEX_PATH] = originalCachedIndex;
        } else {
            delete require.cache[INDEX_PATH];
        }
    }
}

test('buildTriggers() writes config/triggers.json synchronously -- the file is complete and parseable the instant the call returns', () => {
    const { buildTriggers } = require('../src/alexaTriggers');

    const hadOriginal = fs.existsSync(TRIGGERS_JSON_PATH);
    const originalContent = hadOriginal ? fs.readFileSync(TRIGGERS_JSON_PATH, 'utf8') : null;

    const fixtureDevice = {
        id: 'testDevice',
        alexa: { invocations: ['Test Device'], displayCategories: ['SWITCH'] },
    };

    try {
        withFakeIndexExports(
            { devices: [fixtureDevice], deviceScenes: [], lights: [], lightingScenes: [], macros: [] },
            () => buildTriggers()
        );

        // No setImmediate/process.nextTick/await here -- reading the file
        // synchronously right after buildTriggers() returns is exactly the
        // invariant the startup-race fix depends on: index.js calls
        // buildTriggers() and then, later in the same synchronous startup
        // sequence, mqttCommandListener.js's ensureInit() reads this same
        // file back with fs.readFileSync.
        const raw = fs.readFileSync(TRIGGERS_JSON_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        assert.strictEqual(Array.isArray(parsed), true);
        assert.strictEqual(parsed.length, 1);
        assert.strictEqual(parsed[0].endpointId, 'testDevice');
        assert.strictEqual(parsed[0].apiModule, 'DEVICES');
    } finally {
        if (hadOriginal) {
            fs.writeFileSync(TRIGGERS_JSON_PATH, originalContent);
        } else {
            fs.rmSync(TRIGGERS_JSON_PATH, { force: true });
        }
    }
});

test('buildTriggers() logs and does not throw if the write fails -- a disk error must not crash startup', () => {
    const { buildTriggers } = require('../src/alexaTriggers');

    const originalWriteFileSync = fs.writeFileSync;
    const originalConsoleError = console.error;
    const errors = [];
    fs.writeFileSync = () => {
        throw new Error('simulated disk failure');
    };
    console.error = (...args) => errors.push(util.format(...args));

    try {
        withFakeIndexExports(
            { devices: [], deviceScenes: [], lights: [], lightingScenes: [], macros: [] },
            () => {
                assert.doesNotThrow(() => buildTriggers());
            }
        );
        assert.ok(
            errors.some((l) => l.includes('Error writing to triggers.json')),
            `expected the "Error writing to triggers.json" log line, got: ${JSON.stringify(errors)}`
        );
    } finally {
        fs.writeFileSync = originalWriteFileSync;
        console.error = originalConsoleError;
    }
});
