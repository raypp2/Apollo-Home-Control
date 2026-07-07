/**
 * Unit tests for src/lightingPhilipsHueListener.js (Stage 4 of the MQTT plan,
 * issue #12): the hand-rolled SSE parser, CLIP v2 UUID-map building, event
 * dispatch (grouped_light -> canonical state), and the v1 fallback-poll
 * state mapping.
 *
 * Test-instrumentation approach: mirrors lightingShelly.test.js /
 * lightingInsteonListener.test.js. mqttTopics.js is wired to fixture lights
 * via its own `_init({ lights, devices, publish })` -- exactly like those
 * tests -- and lightingPhilipsHueListener's own `_init({ lights, uuidMap })`
 * seeds the module's `lights_new` and, for dispatch tests, a pre-built uuid
 * map directly, so no real HTTPS call to a Hue bridge ever happens here. The
 * SSE parser is exercised through the exported `_ingest(chunk)` hook, which
 * feeds bytes through the real frame-splitting/data-line/JSON.parse logic
 * exactly as the real response stream would. No real network involved.
 */

'use strict';

const assert = require('node:assert');
const { test, beforeEach } = require('node:test');

const mqttTopics = require('../src/mqttTopics');
const listener = require('../src/lightingPhilipsHueListener');

let published;

function fakePublish(topic, payload, opts) {
    published.push({ topic, payload, opts });
}

// Matches the real lights.json shape described in the task brief: two
// hue-group entries, no `location`/`mqttName` overrides (topics default to
// apollo/home/hue/<id>/state).
const giantP = {
    id: 'giantP',
    type: 'hue-group',
    address: '5',
};

const bedroomColor = {
    id: 'bedroomColor',
    type: 'hue-group',
    address: '3',
};

// A third fixture used only where a test needs a topic guaranteed to have no
// prior cached state (mqttTopics' stateCache is module-level and, per its own
// module doc comment / test/mqttTopics.test.js, deliberately persists across
// tests within a file so publishState's merge behavior can be exercised --
// giantP/bedroomColor accumulate prior state from earlier tests in this file,
// so a "does this merge fabricate a field" assertion needs an untouched entry).
const sideLamp = {
    id: 'sideLamp',
    type: 'hue-group',
    address: '7',
};

const GIANT_P_UUID = '11111111-1111-1111-1111-111111111111';
const BEDROOM_COLOR_UUID = '22222222-2222-2222-2222-222222222222';
const SIDE_LAMP_UUID = '33333333-3333-3333-3333-333333333333';

beforeEach(() => {
    published = [];
    mqttTopics._init({ lights: [giantP, bedroomColor, sideLamp], devices: [], publish: fakePublish });
    // _resetForTesting() clears connection/timer/uuid-map state left over from
    // a prior test before re-seeding the fixture uuid map via _init().
    listener._resetForTesting();
    listener._init({
        lights: [giantP, bedroomColor, sideLamp],
        publish: fakePublish,
        uuidMap: new Map([
            [GIANT_P_UUID, giantP],
            [BEDROOM_COLOR_UUID, bedroomColor],
            [SIDE_LAMP_UUID, sideLamp],
        ]),
    });
    for (const entry of [giantP, bedroomColor, sideLamp]) {
        delete entry.checked;
        delete entry.status;
    }
});

function sseFrame(dataObj) {
    return `id: 1\ndata: ${JSON.stringify(dataObj)}\n\n`;
}

function updateBatch(items) {
    return [{ type: 'update', data: items }];
}

// --- SSE parser: framing, chunk splits, comments, malformed JSON ---

test('parses a single complete frame delivered in one chunk', () => {
    const frame = sseFrame(updateBatch([
        { id: GIANT_P_UUID, id_v1: '/groups/5', type: 'grouped_light', on: { on: true } },
    ]));

    listener._ingest(frame);

    assert.strictEqual(published.length, 1);
    assert.strictEqual(published[0].topic, 'apollo/home/hue/giantP/state');
    assert.strictEqual(published[0].payload.power, 'ON');
});

test('parses a JSON payload split across two TCP chunks', () => {
    const frame = sseFrame(updateBatch([
        { id: GIANT_P_UUID, id_v1: '/groups/5', type: 'grouped_light', on: { on: false } },
    ]));
    const splitPoint = Math.floor(frame.length / 2);

    listener._ingest(frame.slice(0, splitPoint));
    assert.strictEqual(published.length, 0, 'no complete frame yet -- must not parse a partial chunk');

    listener._ingest(frame.slice(splitPoint));
    assert.strictEqual(published.length, 1);
    assert.strictEqual(published[0].payload.power, 'OFF');
});

test('parses multiple frames delivered in a single chunk', () => {
    const frame1 = sseFrame(updateBatch([
        { id: GIANT_P_UUID, id_v1: '/groups/5', type: 'grouped_light', on: { on: true } },
    ]));
    const frame2 = sseFrame(updateBatch([
        { id: BEDROOM_COLOR_UUID, id_v1: '/groups/3', type: 'grouped_light', on: { on: false } },
    ]));

    listener._ingest(frame1 + frame2);

    assert.strictEqual(published.length, 2);
    assert.strictEqual(published[0].topic, 'apollo/home/hue/giantP/state');
    assert.strictEqual(published[1].topic, 'apollo/home/hue/bedroomColor/state');
});

test('comment lines (": hi" handshake) and id: lines are ignored, not treated as data', () => {
    listener._ingest(': hi\n\n');
    assert.strictEqual(published.length, 0);

    const frame = `: hi\nid: 42\ndata: ${JSON.stringify(updateBatch([
        { id: GIANT_P_UUID, id_v1: '/groups/5', type: 'grouped_light', on: { on: true } },
    ]))}\n\n`;
    listener._ingest(frame);
    assert.strictEqual(published.length, 1);
});

test('malformed JSON in a frame is logged and ignored, not thrown', () => {
    assert.doesNotThrow(() => {
        listener._ingest('data: {not valid json\n\n');
    });
    assert.strictEqual(published.length, 0);
});

test('a data: payload that is not a JSON array is ignored, not thrown', () => {
    assert.doesNotThrow(() => {
        listener._ingest('data: {"type":"update"}\n\n');
    });
    assert.strictEqual(published.length, 0);
});

// --- UUID map building ---

test('_buildUuidMapFromResource matches grouped_light resources to lights.json entries by v1 group number', () => {
    const data = [
        { id: GIANT_P_UUID, id_v1: '/groups/5' },
        { id: BEDROOM_COLOR_UUID, id_v1: '/groups/3' },
    ];

    const map = listener._buildUuidMapFromResource(data, [giantP, bedroomColor]);

    assert.strictEqual(map.get(GIANT_P_UUID), giantP);
    assert.strictEqual(map.get(BEDROOM_COLOR_UUID), bedroomColor);
    assert.strictEqual(map.size, 2);
});

test('_buildUuidMapFromResource skips an unmatched group resource without throwing', () => {
    const data = [
        { id: GIANT_P_UUID, id_v1: '/groups/5' },
        { id: 'unmatched-uuid', id_v1: '/groups/99' }, // no config entry has address "99"
    ];

    let map;
    assert.doesNotThrow(() => {
        map = listener._buildUuidMapFromResource(data, [giantP, bedroomColor]);
    });

    assert.strictEqual(map.size, 1);
    assert.strictEqual(map.get(GIANT_P_UUID), giantP);
    assert.strictEqual(map.has('unmatched-uuid'), false);
});

test('_buildUuidMapFromResource logs (does not throw) when a config entry has no matching resource', () => {
    const data = [
        { id: GIANT_P_UUID, id_v1: '/groups/5' },
        // bedroomColor (address "3") has no corresponding resource here.
    ];

    let map;
    assert.doesNotThrow(() => {
        map = listener._buildUuidMapFromResource(data, [giantP, bedroomColor]);
    });
    assert.strictEqual(map.size, 1);
});

// --- Event dispatch ---

test('on.on true publishes ON', () => {
    listener._handleResourceItem({ id: GIANT_P_UUID, type: 'grouped_light', on: { on: true } });

    assert.strictEqual(published.length, 1);
    assert.strictEqual(published[0].topic, 'apollo/home/hue/giantP/state');
    assert.strictEqual(published[0].payload.power, 'ON');
    assert.strictEqual(published[0].payload.source, 'event');
    assert.strictEqual(giantP.checked, true);
});

test('on.on false publishes OFF', () => {
    listener._handleResourceItem({ id: GIANT_P_UUID, type: 'grouped_light', on: { on: false } });

    assert.strictEqual(published[0].payload.power, 'OFF');
    assert.strictEqual(giantP.checked, false);
});

test('dimming.brightness maps to a rounded brightness field', () => {
    listener._handleResourceItem({ id: GIANT_P_UUID, type: 'grouped_light', dimming: { brightness: 63.7 } });

    assert.strictEqual(published.length, 1);
    assert.strictEqual(published[0].payload.brightness, 64);
    assert.strictEqual(giantP.status, 64);
});

test('a brightness-only event does not fabricate a power field in the publish payload', () => {
    // Uses sideLamp (never published to elsewhere in this file) so
    // publishState's merge has no prior cached power to carry forward --
    // see the sideLamp fixture comment above.
    listener._handleResourceItem({ id: SIDE_LAMP_UUID, type: 'grouped_light', dimming: { brightness: 40 } });

    assert.strictEqual(published.length, 1);
    assert.strictEqual('power' in published[0].payload, false, 'power must be absent, not guessed');
    assert.strictEqual(published[0].payload.brightness, 40);
    assert.strictEqual(sideLamp.checked, undefined, 'in-memory checked must not be fabricated either');
});

test('an event for an unknown uuid is ignored silently, no throw', () => {
    assert.doesNotThrow(() => {
        listener._handleResourceItem({ id: 'not-in-map', type: 'grouped_light', on: { on: true } });
    });
    assert.strictEqual(published.length, 0);
});

test('a non-grouped_light resource type is ignored silently', () => {
    assert.doesNotThrow(() => {
        listener._handleResourceItem({ id: GIANT_P_UUID, type: 'light', on: { on: true } });
    });
    assert.strictEqual(published.length, 0);
});

test('an event with neither on nor dimming publishes nothing', () => {
    listener._handleResourceItem({ id: GIANT_P_UUID, type: 'grouped_light', alert: { action: 'breathe' } });
    assert.strictEqual(published.length, 0);
});

test('color/color_temperature fields are stashed but never published (Stage 12 groundwork)', () => {
    listener._handleResourceItem({
        id: GIANT_P_UUID,
        type: 'grouped_light',
        on: { on: true },
        color: { xy: { x: 0.3, y: 0.3 } },
    });

    assert.strictEqual(published.length, 1);
    assert.strictEqual('color' in published[0].payload, false, 'color must not be published yet');
});

// --- v1 fallback poll mapping ---

test('_mapV1GroupState: bri 254 scales to brightness 100', () => {
    const state = listener._mapV1GroupState({ action: { on: true, bri: 254 } });
    assert.deepStrictEqual(state, { power: 'ON', brightness: 100 });
});

test('_mapV1GroupState: bri 127 scales to brightness 50', () => {
    const state = listener._mapV1GroupState({ action: { on: true, bri: 127 } });
    assert.deepStrictEqual(state, { power: 'ON', brightness: 50 });
});

test('_mapV1GroupState: falls back to state.any_on when action.on is absent', () => {
    const state = listener._mapV1GroupState({ state: { any_on: true } });
    assert.deepStrictEqual(state, { power: 'ON' });
});

test('_mapV1GroupState: action.on false with no bri publishes power only', () => {
    const state = listener._mapV1GroupState({ action: { on: false } });
    assert.deepStrictEqual(state, { power: 'OFF' });
});

test('_mapV1GroupState: returns null for an empty/missing group', () => {
    assert.strictEqual(listener._mapV1GroupState(null), null);
    assert.strictEqual(listener._mapV1GroupState({}), null);
});

test('_mapV1GroupState: action.on takes precedence over state.any_on when both present', () => {
    const state = listener._mapV1GroupState({ action: { on: false }, state: { any_on: true } });
    assert.deepStrictEqual(state, { power: 'OFF' });
});
