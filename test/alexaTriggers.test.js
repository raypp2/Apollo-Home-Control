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
