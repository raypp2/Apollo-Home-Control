/**
 * Unit tests for src/healthMonitor.js.
 *
 * Test-instrumentation approach: healthMonitor.js exposes `_init({ subscribe,
 * publish, findByTopic, publishUnreachable })` (mirroring mqttTopics.js's and
 * lightingInsteonListener.js's override hooks) plus its message handlers
 * (`_handleState`, `_handleBridgeStatus`) and periodic-check functions
 * (`_tick(now)`, `_publishSummary(now)`) directly, so tests never need to go
 * through mqttClient's subscribe/dispatch machinery (already tested by
 * mqttClient.test.js) or real timers. Every tick/summary function takes an
 * explicit `now` (ms since epoch) parameter -- no setTimeout/setInterval is
 * exercised in these tests at all.
 *
 * No broker involved -- these are pure unit tests.
 */

const assert = require('node:assert');
const { test, beforeEach } = require('node:test');

const healthMonitor = require('../src/healthMonitor');

let published;
let unreachablePublished;
let entriesByTopic;

function fakePublish(topic, payload, opts) {
    published.push({ topic, payload, opts });
}

function fakeFindByTopic(topic) {
    return entriesByTopic.has(topic) ? entriesByTopic.get(topic) : null;
}

function fakePublishUnreachable(entry) {
    unreachablePublished.push(entry);
    return { reachable: false };
}

beforeEach(() => {
    published = [];
    unreachablePublished = [];
    entriesByTopic = new Map();
    healthMonitor._resetForTesting();
    healthMonitor._init({
        subscribe: () => {}, // not exercised directly -- handlers are called directly in these tests
        publish: fakePublish,
        findByTopic: fakeFindByTopic,
        publishUnreachable: fakePublishUnreachable,
    });
});

const INSTEON_TOPIC = 'apollo/home/insteon/kitchen/state';
const SHELLY_TOPIC = 'apollo/kitchen/shelly/plug/state';
const SOMFY_TOPIC = 'apollo/home/somfy/shades/state';
const HUE_TOPIC = 'apollo/home/hue/livingroom/state';
const BRIDGE_APOLLO_TOPIC = 'apollo/bridge/apollo/status';
const BRIDGE_SOMFY_TOPIC = 'apollo/bridge/somfy/status';

// --- _handleState: lastSeen tracking, timestamp usage ---

test('_handleState tracks a new topic using the payload timestamp (unix seconds)', () => {
    const nowMs = Date.now();
    const payloadTimestampS = Math.floor(nowMs / 1000) - 50; // 50s ago
    healthMonitor._handleState(INSTEON_TOPIC, { power: 'ON', timestamp: payloadTimestampS });

    const health = healthMonitor.getHealth();
    const detail = health.deviceDetail.find((d) => d.topic === INSTEON_TOPIC);
    assert.ok(detail, 'topic should be tracked');
    assert.strictEqual(detail.lastSeen, payloadTimestampS * 1000);
    assert.strictEqual(detail.state.power, 'ON');
});

test('_handleState falls back to receipt time when payload has no timestamp', () => {
    const before = Date.now();
    healthMonitor._handleState(INSTEON_TOPIC, { power: 'ON' });
    const after = Date.now();

    const detail = healthMonitor.getHealth().deviceDetail.find((d) => d.topic === INSTEON_TOPIC);
    assert.ok(detail.lastSeen >= before && detail.lastSeen <= after);
});

test('_handleState ignores a payload timestamp more than 60s in the future, using receipt time instead', () => {
    const before = Date.now();
    const farFutureS = Math.floor(Date.now() / 1000) + 3600; // 1 hour in the future
    healthMonitor._handleState(INSTEON_TOPIC, { power: 'ON', timestamp: farFutureS });
    const after = Date.now();

    const detail = healthMonitor.getHealth().deviceDetail.find((d) => d.topic === INSTEON_TOPIC);
    assert.ok(detail.lastSeen >= before && detail.lastSeen <= after, 'should use receipt time, not the future timestamp');
});

test('_handleState accepts a payload timestamp up to 60s in the future (sane clock skew)', () => {
    const nearFutureS = Math.floor(Date.now() / 1000) + 30; // 30s ahead -- within the 60s slop
    healthMonitor._handleState(INSTEON_TOPIC, { power: 'ON', timestamp: nearFutureS });

    const detail = healthMonitor.getHealth().deviceDetail.find((d) => d.topic === INSTEON_TOPIC);
    assert.strictEqual(detail.lastSeen, nearFutureS * 1000);
});

test('_handleState never throws on malformed payloads', () => {
    assert.doesNotThrow(() => healthMonitor._handleState(INSTEON_TOPIC, null));
    assert.doesNotThrow(() => healthMonitor._handleState(INSTEON_TOPIC, 'not-an-object'));
    assert.doesNotThrow(() => healthMonitor._handleState(INSTEON_TOPIC, { timestamp: 'garbage' }));
    assert.doesNotThrow(() => healthMonitor._handleState(INSTEON_TOPIC, undefined));
    assert.doesNotThrow(() => healthMonitor._handleState(INSTEON_TOPIC, { timestamp: NaN }));
});

// --- _tick: staleness per ecosystem, fires once, publishUnreachable ---

test('_tick marks an insteon topic stale after 180s and publishes stale + calls publishUnreachable', () => {
    const t0 = 1_000_000_000_000;
    healthMonitor._handleState(INSTEON_TOPIC, { power: 'ON', timestamp: Math.floor(t0 / 1000) });

    const lightEntry = { id: 'kitchen', type: 'insteon' };
    entriesByTopic.set(INSTEON_TOPIC, lightEntry);

    healthMonitor._tick(t0 + 180001); // just past the 180000ms insteon threshold

    const staleHealthPublish = published.find(
        (p) => p.topic === 'apollo/health/home/kitchen/status' && p.payload === 'stale'
    );
    assert.ok(staleHealthPublish, 'should publish retained stale health status');
    assert.deepStrictEqual(staleHealthPublish.opts, { qos: 1, retain: true });

    assert.strictEqual(unreachablePublished.length, 1);
    assert.strictEqual(unreachablePublished[0], lightEntry);

    const detail = healthMonitor.getHealth().deviceDetail.find((d) => d.topic === INSTEON_TOPIC);
    assert.strictEqual(detail.stale, true);
});

test('_tick does not mark an insteon topic stale before 180s', () => {
    const t0 = 1_000_000_000_000;
    healthMonitor._handleState(INSTEON_TOPIC, { power: 'ON', timestamp: Math.floor(t0 / 1000) });

    healthMonitor._tick(t0 + 179000);

    const detail = healthMonitor.getHealth().deviceDetail.find((d) => d.topic === INSTEON_TOPIC);
    assert.strictEqual(detail.stale, false);
    assert.strictEqual(published.length, 0);
});

test('_tick marks a shelly topic stale after 90s', () => {
    const t0 = 1_000_000_000_000;
    healthMonitor._handleState(SHELLY_TOPIC, { power: 'ON', timestamp: Math.floor(t0 / 1000) });

    healthMonitor._tick(t0 + 89000);
    let detail = healthMonitor.getHealth().deviceDetail.find((d) => d.topic === SHELLY_TOPIC);
    assert.strictEqual(detail.stale, false);

    healthMonitor._tick(t0 + 90001);
    detail = healthMonitor.getHealth().deviceDetail.find((d) => d.topic === SHELLY_TOPIC);
    assert.strictEqual(detail.stale, true);
});

test('_tick fires only once per outage (does not re-log/re-publish on subsequent ticks)', () => {
    const t0 = 1_000_000_000_000;
    healthMonitor._handleState(INSTEON_TOPIC, { power: 'ON', timestamp: Math.floor(t0 / 1000) });

    healthMonitor._tick(t0 + 180001);
    const firstPassPublishCount = published.length;
    const firstPassUnreachableCount = unreachablePublished.length;

    healthMonitor._tick(t0 + 210001);
    healthMonitor._tick(t0 + 400001);

    assert.strictEqual(published.length, firstPassPublishCount, 'no additional health publishes on later ticks');
    assert.strictEqual(unreachablePublished.length, firstPassUnreachableCount, 'no additional publishUnreachable calls on later ticks');
});

test('_tick skips the unreachable publish when no config entry resolves, but still publishes the stale health topic', () => {
    const t0 = 1_000_000_000_000;
    healthMonitor._handleState(INSTEON_TOPIC, { power: 'ON', timestamp: Math.floor(t0 / 1000) });
    // entriesByTopic left empty -- findByTopic returns null

    healthMonitor._tick(t0 + 180001);

    assert.strictEqual(unreachablePublished.length, 0);
    const staleHealthPublish = published.find((p) => p.topic === 'apollo/health/home/kitchen/status');
    assert.ok(staleHealthPublish, 'health status topic should still publish even with no resolved entry');
    assert.strictEqual(staleHealthPublish.payload, 'stale');
});

test('_tick never marks somfy stale regardless of age (no time-based threshold)', () => {
    const t0 = 1_000_000_000_000;
    healthMonitor._handleState(SOMFY_TOPIC, { position: 50, timestamp: Math.floor(t0 / 1000) });

    // Far beyond any other ecosystem's threshold -- multiple days.
    healthMonitor._tick(t0 + 1000 * 60 * 60 * 24 * 7);

    const detail = healthMonitor.getHealth().deviceDetail.find((d) => d.topic === SOMFY_TOPIC);
    assert.strictEqual(detail.stale, false);
    assert.strictEqual(published.length, 0);
    assert.strictEqual(unreachablePublished.length, 0);
});

test('_tick never marks hue (or other no-threshold ecosystems) stale regardless of age', () => {
    const t0 = 1_000_000_000_000;
    healthMonitor._handleState(HUE_TOPIC, { power: 'ON', timestamp: Math.floor(t0 / 1000) });

    healthMonitor._tick(t0 + 1000 * 60 * 60 * 24 * 30);

    const detail = healthMonitor.getHealth().deviceDetail.find((d) => d.topic === HUE_TOPIC);
    assert.strictEqual(detail.stale, false);
    assert.strictEqual(published.length, 0);
});

// --- Recovery ---

test('a fresh state message on a stale topic clears the stale mark and publishes "ok"', () => {
    const t0 = 1_000_000_000_000;
    healthMonitor._handleState(INSTEON_TOPIC, { power: 'ON', timestamp: Math.floor(t0 / 1000) });
    healthMonitor._tick(t0 + 180001);

    let detail = healthMonitor.getHealth().deviceDetail.find((d) => d.topic === INSTEON_TOPIC);
    assert.strictEqual(detail.stale, true);

    published = []; // isolate the recovery publish
    const t1 = t0 + 200000;
    healthMonitor._handleState(INSTEON_TOPIC, { power: 'OFF', timestamp: Math.floor(t1 / 1000) });

    detail = healthMonitor.getHealth().deviceDetail.find((d) => d.topic === INSTEON_TOPIC);
    assert.strictEqual(detail.stale, false);

    const okPublish = published.find((p) => p.topic === 'apollo/health/home/kitchen/status');
    assert.ok(okPublish);
    assert.strictEqual(okPublish.payload, 'ok');
    assert.deepStrictEqual(okPublish.opts, { qos: 1, retain: true });
});

test('recovery allows staleness to fire again on a subsequent outage', () => {
    const t0 = 1_000_000_000_000;
    const lightEntry = { id: 'kitchen', type: 'insteon' };
    entriesByTopic.set(INSTEON_TOPIC, lightEntry);

    healthMonitor._handleState(INSTEON_TOPIC, { power: 'ON', timestamp: Math.floor(t0 / 1000) });
    healthMonitor._tick(t0 + 180001);
    healthMonitor._handleState(INSTEON_TOPIC, { power: 'ON', timestamp: Math.floor((t0 + 200000) / 1000) });

    unreachablePublished = [];
    healthMonitor._tick(t0 + 200000 + 180001);

    const detail = healthMonitor.getHealth().deviceDetail.find((d) => d.topic === INSTEON_TOPIC);
    assert.strictEqual(detail.stale, true);
    assert.strictEqual(unreachablePublished.length, 1);
});

// --- Bridge status + summary.degraded ---

test('_handleBridgeStatus tracks bridge status separately from device state', () => {
    healthMonitor._handleBridgeStatus(BRIDGE_APOLLO_TOPIC, 'online');
    const health = healthMonitor.getHealth();
    assert.strictEqual(health.bridges.apollo, 'online');
});

test('_handleBridgeStatus never throws on malformed payloads', () => {
    assert.doesNotThrow(() => healthMonitor._handleBridgeStatus(BRIDGE_APOLLO_TOPIC, null));
    assert.doesNotThrow(() => healthMonitor._handleBridgeStatus(BRIDGE_APOLLO_TOPIC, { unexpected: 'shape' }));
    assert.doesNotThrow(() => healthMonitor._handleBridgeStatus(BRIDGE_APOLLO_TOPIC, 123));
});

test('a bridge going offline flips summary.degraded to true', () => {
    healthMonitor._handleBridgeStatus(BRIDGE_APOLLO_TOPIC, 'online');
    let health = healthMonitor.getHealth();
    assert.strictEqual(health.degraded, false);

    healthMonitor._handleBridgeStatus(BRIDGE_APOLLO_TOPIC, 'offline');
    health = healthMonitor.getHealth();
    assert.strictEqual(health.degraded, true);
    assert.strictEqual(health.bridges.apollo, 'offline');
});

test('degraded reflects multiple bridges independently', () => {
    healthMonitor._handleBridgeStatus(BRIDGE_APOLLO_TOPIC, 'online');
    healthMonitor._handleBridgeStatus(BRIDGE_SOMFY_TOPIC, 'offline');

    const health = healthMonitor.getHealth();
    assert.strictEqual(health.bridges.apollo, 'online');
    assert.strictEqual(health.bridges.somfy, 'offline');
    assert.strictEqual(health.degraded, true);
});

test('degraded is true when any device is stale, even with all bridges online', () => {
    const t0 = 1_000_000_000_000;
    healthMonitor._handleBridgeStatus(BRIDGE_APOLLO_TOPIC, 'online');
    healthMonitor._handleState(INSTEON_TOPIC, { power: 'ON', timestamp: Math.floor(t0 / 1000) });
    healthMonitor._tick(t0 + 180001);

    const health = healthMonitor.getHealth();
    assert.strictEqual(health.degraded, true);
    assert.deepStrictEqual(health.stale, [INSTEON_TOPIC]);
});

// --- _publishSummary shape ---

test('_publishSummary publishes the documented summary shape, retained', () => {
    const t0 = 1_000_000_000_000;
    healthMonitor._handleBridgeStatus(BRIDGE_APOLLO_TOPIC, 'online');
    healthMonitor._handleState(INSTEON_TOPIC, { power: 'ON', timestamp: Math.floor(t0 / 1000) });
    healthMonitor._handleState(SHELLY_TOPIC, { power: 'OFF', timestamp: Math.floor(t0 / 1000) });

    const summary = healthMonitor._publishSummary(t0);

    assert.strictEqual(summary.timestamp, Math.floor(t0 / 1000));
    assert.strictEqual(summary.devices, 2);
    assert.deepStrictEqual(summary.stale, []);
    assert.deepStrictEqual(summary.bridges, { apollo: 'online' });
    assert.strictEqual(summary.degraded, false);

    const summaryPublish = published.find((p) => p.topic === 'apollo/health/summary');
    assert.ok(summaryPublish);
    assert.deepStrictEqual(summaryPublish.payload, summary);
    assert.deepStrictEqual(summaryPublish.opts, { qos: 1, retain: true });
});

// --- getHealth(): per-device ageSeconds math + overall shape ---

test('getHealth returns per-device ageSeconds computed from lastSeen', () => {
    const t0 = Date.now() - 45000; // 45s ago, using real receipt time (no timestamp field)
    const originalNow = Date.now;
    try {
        Date.now = () => t0;
        healthMonitor._handleState(INSTEON_TOPIC, { power: 'ON' });
    } finally {
        Date.now = originalNow;
    }

    const health = healthMonitor.getHealth();
    const detail = health.deviceDetail.find((d) => d.topic === INSTEON_TOPIC);
    assert.ok(detail.ageSeconds >= 44 && detail.ageSeconds <= 47, `expected ~45s, got ${detail.ageSeconds}`);
});

test('getHealth includes the summary fields plus a deviceDetail array', () => {
    healthMonitor._handleState(INSTEON_TOPIC, { power: 'ON' });
    healthMonitor._handleBridgeStatus(BRIDGE_APOLLO_TOPIC, 'online');

    const health = healthMonitor.getHealth();
    assert.ok(Number.isInteger(health.timestamp));
    assert.strictEqual(health.devices, 1);
    assert.ok(Array.isArray(health.stale));
    assert.ok(typeof health.bridges === 'object');
    assert.ok(typeof health.degraded === 'boolean');
    assert.ok(Array.isArray(health.deviceDetail));

    const detail = health.deviceDetail[0];
    assert.strictEqual(detail.topic, INSTEON_TOPIC);
    assert.ok('lastSeen' in detail);
    assert.ok('ageSeconds' in detail);
    assert.ok('stale' in detail);
    assert.ok('state' in detail);
});

test('getHealth with nothing tracked yet returns an empty-but-valid shape', () => {
    const health = healthMonitor.getHealth();
    assert.strictEqual(health.devices, 0);
    assert.deepStrictEqual(health.stale, []);
    assert.deepStrictEqual(health.bridges, {});
    assert.strictEqual(health.degraded, false);
    assert.deepStrictEqual(health.deviceDetail, []);
});
