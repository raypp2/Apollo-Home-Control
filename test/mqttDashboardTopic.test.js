/**
 * Unit tests for public/js/mqttDashboard.js's stateTopicFor() pure function.
 *
 * public/js/mqttDashboard.js is plain browser JS (no build step, loaded via a
 * <script> tag) -- it is NOT part of the eslint'd/tested src/ tree. To make
 * its one piece of non-trivial logic (stateTopicFor, which mirrors
 * src/mqttTopics.js's topicFor()/ecosystemFor()/slugify() defaulting rules)
 * testable from Node without a browser, the file guards its browser-only
 * wiring (window.mqtt.connect(), window.apolloLive, DOM) behind
 * `typeof window !== 'undefined'` and always exports its pure functions via
 * `if (typeof module !== 'undefined' && module.exports) { module.exports = {...} }`
 * at the end -- the same dual browser/Node technique used elsewhere in this
 * codebase for tolerant requiring. Requiring it here from Node (no `window`
 * global) exercises only the pure-function branch; nothing here starts an
 * MQTT connection or touches a broker.
 */

const assert = require('node:assert');
const { test } = require('node:test');

const { stateTopicFor, ecosystemFor, slugify } = require('../public/js/mqttDashboard');

test('stateTopicFor uses defaults: location "home", mqttName falls back to id', () => {
    const entry = { id: 'kitchen', type: 'insteon' };
    assert.strictEqual(stateTopicFor(entry), 'apollo/home/insteon/kitchen/state');
});

test('stateTopicFor uses explicit location and mqttName when present', () => {
    const entry = { id: 'livingRoomBookshelf', type: 'insteon', location: 'living-room', mqttName: 'bookshelf' };
    assert.strictEqual(stateTopicFor(entry), 'apollo/living-room/insteon/bookshelf/state');
});

test('stateTopicFor lowercases location and replaces spaces with hyphens', () => {
    const entry = { id: 'x', type: 'insteon', location: 'Living Room' };
    assert.strictEqual(stateTopicFor(entry), 'apollo/living-room/insteon/x/state');
});

test('stateTopicFor maps every documented config `type` to its topic ecosystem, matching src/mqttTopics.js', () => {
    const cases = [
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
    for (const [type, ecosystem] of cases) {
        assert.strictEqual(ecosystemFor({ type }), ecosystem, `type ${type} should map to ecosystem ${ecosystem}`);
        assert.strictEqual(stateTopicFor({ id: 'x', type }), `apollo/home/${ecosystem}/x/state`);
    }
});

test('stateTopicFor falls back to ecosystem "x" for an unrecognized/missing type', () => {
    assert.strictEqual(stateTopicFor({ id: 'x' }), 'apollo/home/x/x/state');
    assert.strictEqual(stateTopicFor({ id: 'x', type: 'somethingUnknown' }), 'apollo/home/x/x/state');
});

test('slugify matches src/mqttTopics.js: lowercase + spaces to hyphens', () => {
    assert.strictEqual(slugify('Living Room'), 'living-room');
    assert.strictEqual(slugify('home'), 'home');
});
