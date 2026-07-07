/**
 * Unit tests for src/mqttTopics.js.
 *
 * mqttTopics.js normally requires('../index'), which (as a side effect of
 * being required) loads config/*.json and starts servers -- not something we
 * want to boot in a unit test. To test the pure topic/payload logic without
 * booting index.js, mqttTopics.js exposes an internal `_init({lights, devices,
 * publish})` override (see the comment at the top of src/mqttTopics.js). We
 * call `_init()` with fixture arrays and a spy `publish` before any other
 * calls, which sets its "initialized" flag and means the real
 * require('../index') never happens.
 *
 * No broker involved -- these are pure unit tests.
 */

const assert = require('node:assert');
const { test, beforeEach } = require('node:test');

const mqttTopics = require('../src/mqttTopics');

let published;

function fakePublish(topic, payload, opts) {
    published.push({ topic, payload, opts });
}

beforeEach(() => {
    published = [];
    mqttTopics._init({ lights: [], devices: [], publish: fakePublish });
});

// --- topicFor: defaults + hyphenation ---

test('topicFor uses defaults: location "home", mqttName falls back to id', () => {
    const entry = { id: 'kitchen', type: 'insteon' };
    assert.strictEqual(
        mqttTopics.topicFor(entry, 'state'),
        'apollo/home/insteon/kitchen/state'
    );
});

test('topicFor uses explicit location and mqttName when present', () => {
    const entry = { id: 'livingRoomBookshelf', type: 'insteon', location: 'living-room', mqttName: 'bookshelf' };
    assert.strictEqual(
        mqttTopics.topicFor(entry, 'state'),
        'apollo/living-room/insteon/bookshelf/state'
    );
});

test('topicFor lowercases location and replaces spaces with hyphens', () => {
    const entry = { id: 'x', type: 'insteon', location: 'Living Room' };
    assert.strictEqual(
        mqttTopics.topicFor(entry, 'state'),
        'apollo/living-room/insteon/x/state'
    );
});

test('topicFor supports arbitrary attribute segments (set, status)', () => {
    const entry = { id: 'x', type: 'shelly' };
    assert.strictEqual(mqttTopics.topicFor(entry, 'set'), 'apollo/home/shelly/x/set');
    assert.strictEqual(mqttTopics.topicFor(entry, 'status'), 'apollo/home/shelly/x/status');
});

// --- ecosystem mapping: every documented config `type` -> topic ecosystem ---

const ECOSYSTEM_CASES = [
    ['insteon', 'insteon'],
    ['hue-group', 'hue'],
    ['dmxFixture', 'dmx'],
    ['shelly', 'shelly'],
    ['wled', 'wled'],
    ['iTach_serial', 'itach'],
    ['iTach_ir', 'itach'],
    ['iTach_CC', 'itach'],
    ['ip_control', 'ip'],
    ['Somfy-Bridge', 'somfy'],
    ['spotify', 'spotify'],
];

for (const [type, ecosystem] of ECOSYSTEM_CASES) {
    test(`topicFor maps type "${type}" to ecosystem "${ecosystem}"`, () => {
        const entry = { id: 'thing', type };
        assert.strictEqual(mqttTopics.topicFor(entry, 'state'), `apollo/home/${ecosystem}/thing/state`);
    });
}

test('topicFor maps an unknown type to ecosystem "x"', () => {
    const entry = { id: 'thing', type: 'someFutureType' };
    assert.strictEqual(mqttTopics.topicFor(entry, 'state'), 'apollo/home/x/thing/state');
});

test('topicFor maps a missing type to ecosystem "x"', () => {
    const entry = { id: 'thing' };
    assert.strictEqual(mqttTopics.topicFor(entry, 'state'), 'apollo/home/x/thing/state');
});

// --- publishState: payload shape, merge behavior ---

test('publishState publishes required fields: reachable, timestamp (seconds), source', () => {
    const entry = { id: 'kitchen', type: 'insteon' };
    const before = Math.floor(Date.now() / 1000);
    const result = mqttTopics.publishState(entry, { power: 'ON' }, 'command');
    const after = Math.floor(Date.now() / 1000);

    assert.strictEqual(result.power, 'ON');
    assert.strictEqual(result.reachable, true);
    assert.strictEqual(result.source, 'command');
    assert.ok(Number.isInteger(result.timestamp));
    assert.ok(result.timestamp >= before && result.timestamp <= after, 'timestamp should be unix seconds, not ms');

    assert.strictEqual(published.length, 1);
    assert.strictEqual(published[0].topic, 'apollo/home/insteon/kitchen/state');
    assert.deepStrictEqual(published[0].payload, result);
    assert.deepStrictEqual(published[0].opts, { qos: 1, retain: true });
});

test('publishState omits brightness when not provided', () => {
    const entry = { id: 'kitchen', type: 'insteon' };
    const result = mqttTopics.publishState(entry, { power: 'OFF' }, 'event');
    assert.strictEqual('brightness' in result, false);
});

test('publishState: a brightness-only update does not erase a previously known power field', () => {
    const entry = { id: 'kitchen', type: 'insteon' };
    mqttTopics.publishState(entry, { power: 'ON', brightness: 40 }, 'command');
    const result = mqttTopics.publishState(entry, { brightness: 80 }, 'poll');

    assert.strictEqual(result.power, 'ON', 'power should be preserved from prior state');
    assert.strictEqual(result.brightness, 80);
    assert.strictEqual(result.source, 'poll');
});

test('publishState accepts all documented source values', () => {
    const entry = { id: 'kitchen', type: 'insteon' };
    for (const source of ['command', 'event', 'poll']) {
        const result = mqttTopics.publishState(entry, { power: 'ON' }, source);
        assert.strictEqual(result.source, source);
    }
});

// --- publishUnreachable ---

test('publishUnreachable sets reachable:false while preserving prior fields', () => {
    const entry = { id: 'kitchen', type: 'insteon' };
    mqttTopics.publishState(entry, { power: 'ON', brightness: 55 }, 'event');
    const result = mqttTopics.publishUnreachable(entry);

    assert.strictEqual(result.reachable, false);
    assert.strictEqual(result.power, 'ON', 'prior power should be preserved');
    assert.strictEqual(result.brightness, 55, 'prior brightness should be preserved');

    const lastPublish = published[published.length - 1];
    assert.strictEqual(lastPublish.topic, 'apollo/home/insteon/kitchen/state');
    assert.deepStrictEqual(lastPublish.opts, { qos: 1, retain: true });
});

test('publishUnreachable with no prior state still publishes a minimal reachable:false payload', () => {
    const entry = { id: 'freshDevice', type: 'shelly' };
    const result = mqttTopics.publishUnreachable(entry);
    assert.strictEqual(result.reachable, false);
    assert.ok(Number.isInteger(result.timestamp));
});

// --- lastState ---

test('lastState returns null before any publish', () => {
    const entry = { id: 'neverPublished', type: 'insteon' };
    assert.strictEqual(mqttTopics.lastState(entry), null);
});

test('lastState returns the cached state after a publish', () => {
    const entry = { id: 'kitchen', type: 'insteon' };
    mqttTopics.publishState(entry, { power: 'ON' }, 'command');
    const cached = mqttTopics.lastState(entry);
    assert.strictEqual(cached.power, 'ON');
});

// --- findByTopic ---

test('findByTopic finds a light by its state topic', () => {
    const light = { id: 'kitchen', type: 'insteon' };
    mqttTopics._init({ lights: [light], devices: [], publish: fakePublish });

    const found = mqttTopics.findByTopic('apollo/home/insteon/kitchen/state');
    assert.strictEqual(found, light);
});

test('findByTopic finds a device by its set topic', () => {
    const device = { id: 'shades', type: 'Somfy-Bridge', mqttName: 'shades' };
    mqttTopics._init({ lights: [], devices: [device], publish: fakePublish });

    const found = mqttTopics.findByTopic('apollo/home/somfy/shades/set');
    assert.strictEqual(found, device);
});

test('findByTopic matches by mqttName, not id, when mqttName differs', () => {
    const light = { id: 'livingRoomBookshelf', type: 'insteon', location: 'living-room', mqttName: 'bookshelf' };
    mqttTopics._init({ lights: [light], devices: [], publish: fakePublish });

    assert.strictEqual(mqttTopics.findByTopic('apollo/living-room/insteon/bookshelf/state'), light);
    assert.strictEqual(mqttTopics.findByTopic('apollo/living-room/insteon/livingRoomBookshelf/state'), null);
});

test('findByTopic returns null for no match', () => {
    const light = { id: 'kitchen', type: 'insteon' };
    mqttTopics._init({ lights: [light], devices: [], publish: fakePublish });

    assert.strictEqual(mqttTopics.findByTopic('apollo/home/insteon/nonexistent/state'), null);
});

test('findByTopic returns null for a malformed topic', () => {
    const light = { id: 'kitchen', type: 'insteon' };
    mqttTopics._init({ lights: [light], devices: [], publish: fakePublish });

    assert.strictEqual(mqttTopics.findByTopic('not/a/valid/apollo/topic/at/all'), null);
    assert.strictEqual(mqttTopics.findByTopic('apollo/home/insteon'), null);
});
