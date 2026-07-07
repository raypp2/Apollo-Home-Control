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

// --- isAlexaStateful ---

const STATEFUL_TYPES = ['insteon', 'hue-group', 'shelly', 'Somfy-Bridge'];
const NON_STATEFUL_TYPES = ['wled', 'dmxFixture', 'iTach_serial', 'iTach_ir', 'iTach_CC', 'ip_control', 'spotify'];

for (const type of STATEFUL_TYPES) {
    test(`isAlexaStateful: type "${type}" WITH alexa config is stateful`, () => {
        const entry = { id: 'thing', type, alexa: { invocations: ['Thing'] } };
        assert.strictEqual(mqttTopics.isAlexaStateful(entry), true);
    });

    test(`isAlexaStateful: type "${type}" WITHOUT alexa config is not stateful`, () => {
        const entry = { id: 'thing', type };
        assert.strictEqual(mqttTopics.isAlexaStateful(entry), false);
    });
}

for (const type of NON_STATEFUL_TYPES) {
    test(`isAlexaStateful: type "${type}" WITH alexa config is still not stateful (doesn't publish MQTT state)`, () => {
        const entry = { id: 'thing', type, alexa: { invocations: ['Thing'] } };
        assert.strictEqual(mqttTopics.isAlexaStateful(entry), false);
    });
}

test('isAlexaStateful returns false for a missing/undefined entry', () => {
    assert.strictEqual(mqttTopics.isAlexaStateful(undefined), false);
    assert.strictEqual(mqttTopics.isAlexaStateful(null), false);
});

// --- shadow envelope publishing (Stage 7) ---

test('publishState: a stateful insteon entry publishes BOTH the canonical retained state AND a non-retained shadow envelope', () => {
    const entry = { id: 'kitchen', type: 'insteon', alexa: { invocations: ['Kitchen'] } };
    const result = mqttTopics.publishState(entry, { power: 'ON', brightness: 80 }, 'command');

    assert.strictEqual(published.length, 2, 'expected canonical publish + shadow publish');

    const canonical = published[0];
    assert.strictEqual(canonical.topic, 'apollo/home/insteon/kitchen/state');
    assert.deepStrictEqual(canonical.payload, result);
    assert.deepStrictEqual(canonical.opts, { qos: 1, retain: true });

    const shadow = published[1];
    assert.strictEqual(shadow.topic, '$aws/things/apollo-kitchen/shadow/update');
    assert.deepStrictEqual(shadow.payload, { state: { reported: result } });
    assert.deepStrictEqual(shadow.opts, { qos: 1, retain: false }, 'shadow envelope must NOT be retained locally');
});

for (const type of ['hue-group', 'shelly', 'Somfy-Bridge']) {
    test(`publishState: stateful type "${type}" also publishes the shadow envelope`, () => {
        const entry = { id: 'thing', type, alexa: { invocations: ['Thing'] } };
        mqttTopics.publishState(entry, { power: 'ON' }, 'event');

        assert.strictEqual(published.length, 2);
        assert.strictEqual(published[1].topic, '$aws/things/apollo-thing/shadow/update');
    });
}

test('publishState: a dmx entry (not alexa-stateful-eligible type) publishes canonical only, no shadow', () => {
    const entry = { id: 'ceiling', type: 'dmxFixture', alexa: { invocations: ['Ceiling'] } };
    mqttTopics.publishState(entry, { power: 'ON' }, 'command');

    assert.strictEqual(published.length, 1, 'dmx should not get a shadow envelope');
    assert.strictEqual(published[0].topic, 'apollo/home/dmx/ceiling/state');
});

test('publishState: a wled entry (not alexa-stateful-eligible type) publishes canonical only, no shadow', () => {
    const entry = { id: 'strips', type: 'wled', alexa: { invocations: ['Strips'] } };
    mqttTopics.publishState(entry, { power: 'ON' }, 'command');

    assert.strictEqual(published.length, 1, 'wled should not get a shadow envelope');
    assert.strictEqual(published[0].topic, 'apollo/home/wled/strips/state');
});

test('publishState: an insteon entry with NO alexa config publishes canonical only, no shadow', () => {
    const entry = { id: 'kitchen', type: 'insteon' };
    mqttTopics.publishState(entry, { power: 'ON' }, 'command');

    assert.strictEqual(published.length, 1, 'entries without alexa config should not get a shadow envelope');
    assert.strictEqual(published[0].topic, 'apollo/home/insteon/kitchen/state');
});

test('publishUnreachable: a stateful entry also mirrors reachable:false to the shadow envelope', () => {
    const entry = { id: 'kitchen', type: 'insteon', alexa: { invocations: ['Kitchen'] } };
    mqttTopics.publishState(entry, { power: 'ON', brightness: 55 }, 'event');
    published.length = 0;

    const result = mqttTopics.publishUnreachable(entry);

    assert.strictEqual(published.length, 2, 'expected canonical publish + shadow publish');

    const canonical = published[0];
    assert.strictEqual(canonical.topic, 'apollo/home/insteon/kitchen/state');
    assert.strictEqual(canonical.payload.reachable, false);
    assert.deepStrictEqual(canonical.opts, { qos: 1, retain: true });

    const shadow = published[1];
    assert.strictEqual(shadow.topic, '$aws/things/apollo-kitchen/shadow/update');
    assert.deepStrictEqual(shadow.payload, { state: { reported: result } });
    assert.strictEqual(shadow.payload.state.reported.reachable, false);
    assert.deepStrictEqual(shadow.opts, { qos: 1, retain: false });
});

test('publishUnreachable: a non-stateful-type entry publishes canonical only, no shadow', () => {
    const entry = { id: 'strips', type: 'wled', alexa: { invocations: ['Strips'] } };
    mqttTopics.publishUnreachable(entry);

    assert.strictEqual(published.length, 1);
});
