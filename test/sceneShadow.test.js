/**
 * Unit tests for src/sceneShadow.js.
 *
 * Test-instrumentation approach: sceneShadow.js exposes `_init({ subscribe,
 * publish, settleMs, quietMs })` (mirroring healthMonitor.js's override hook)
 * plus its message handler (`_handleDeviceState`, matching mqttClient's
 * `(topic, payload, rawBuffer, retain)` signature) directly, so tests never
 * need to go through mqttClient's subscribe/dispatch machinery. settleMs/
 * quietMs are overridden to a few milliseconds so fingerprint-learning tests
 * don't wait on the real ~3s settle window -- they drive real (but tiny)
 * timers via `await sleep(ms)` rather than faking Date.now()/setTimeout,
 * since sceneShadow.js's timing is timer-based (setTimeout), not an explicit
 * `now` parameter like healthMonitor's _tick().
 *
 * No broker involved -- these are pure unit tests.
 */

const assert = require('node:assert');
const { test, beforeEach } = require('node:test');

const sceneShadow = require('../src/sceneShadow');

const SETTLE_MS = 40;
const QUIET_MS = 15;
// Comfortably past SETTLE_MS/QUIET_MS so pending timers have definitely fired.
const WAIT_MS = 120;

let published;

function fakePublish(topic, payload, opts) {
    published.push({ topic, payload, opts });
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function publishesFor(topic) {
    return published.filter((p) => p.topic === topic);
}

function lastPublishFor(topic) {
    const matches = publishesFor(topic);
    return matches[matches.length - 1];
}

beforeEach(() => {
    published = [];
    sceneShadow._resetForTesting();
    sceneShadow._init({
        subscribe: () => {}, // not exercised -- _handleDeviceState is called directly
        publish: fakePublish,
        settleMs: SETTLE_MS,
        quietMs: QUIET_MS,
    });
});

const KITCHEN_TOPIC = 'apollo/home/insteon/kitchen/state';
const GIANTP_TOPIC = 'apollo/home/hue/giantP/state';
const UNRELATED_TOPIC = 'apollo/home/insteon/hall/state';

// --- onSceneActivated: immediate publish ---

test('scene on immediately publishes active:true, retained, with activatedAt', () => {
    const before = Math.floor(Date.now() / 1000);
    sceneShadow.onSceneActivated('hangoutMode', 'on');
    const after = Math.floor(Date.now() / 1000);

    const topic = 'apollo/home/scene/hangoutMode/state';
    const pub = lastPublishFor(topic);
    assert.ok(pub, 'scene state should publish immediately');
    assert.strictEqual(pub.payload.active, true);
    assert.strictEqual(pub.payload.source, 'command');
    assert.ok(pub.payload.activatedAt >= before && pub.payload.activatedAt <= after);
    assert.deepStrictEqual(pub.payload.fingerprint, {});
    assert.deepStrictEqual(pub.opts, { qos: 1, retain: true });
});

test('scene off publishes active:false with an empty fingerprint', () => {
    sceneShadow.onSceneActivated('hangoutMode', 'on');
    sceneShadow.onSceneActivated('hangoutMode', 'off');

    const topic = 'apollo/home/scene/hangoutMode/state';
    const pub = lastPublishFor(topic);
    assert.strictEqual(pub.payload.active, false);
    assert.deepStrictEqual(pub.payload.fingerprint, {});
});

test('any command other than "OFF" (case-insensitive) is treated as active', () => {
    sceneShadow.onSceneActivated('allLights', 'ON');
    assert.strictEqual(lastPublishFor('apollo/home/scene/allLights/state').payload.active, true);

    sceneShadow.onSceneActivated('allLights', 'off');
    assert.strictEqual(lastPublishFor('apollo/home/scene/allLights/state').payload.active, false);

    sceneShadow.onSceneActivated('allLights', 'Off');
    assert.strictEqual(lastPublishFor('apollo/home/scene/allLights/state').payload.active, false);
});

// --- Fingerprint learning ---

test('fingerprint is learned from devices that changed between activation and settle, excluding unchanged devices', async () => {
    // Baseline state for two devices before the scene fires.
    sceneShadow._handleDeviceState(KITCHEN_TOPIC, { power: 'OFF', brightness: 0, reachable: true, timestamp: 1, source: 'poll' });
    sceneShadow._handleDeviceState(GIANTP_TOPIC, { power: 'OFF', brightness: 0, reachable: true, timestamp: 1, source: 'poll' });

    sceneShadow.onSceneActivated('livingRoom', 'on');

    // Simulate the hub actually moving the kitchen light; giantP is left
    // untouched (e.g. it's not actually a member of this scene).
    sceneShadow._handleDeviceState(KITCHEN_TOPIC, { power: 'ON', brightness: 60, reachable: true, timestamp: 2, source: 'poll' });

    await sleep(WAIT_MS);

    const pub = lastPublishFor('apollo/home/scene/livingRoom/state');
    assert.strictEqual(pub.payload.active, true);
    assert.deepStrictEqual(pub.payload.fingerprint, {
        [KITCHEN_TOPIC]: { power: 'ON', brightness: 60 },
    });
    assert.ok(!(GIANTP_TOPIC in pub.payload.fingerprint), 'unchanged device should not appear in fingerprint');
});

test('quiet-timer extends the settle window while state messages keep arriving', async () => {
    sceneShadow._handleDeviceState(KITCHEN_TOPIC, { power: 'OFF', brightness: 0 });
    sceneShadow.onSceneActivated('livingRoom', 'on');

    // Keep "poking" within the quiet window so the settle timer keeps
    // resetting -- the fingerprint must not finalize until things go quiet.
    for (let i = 0; i < 3; i++) {
        await sleep(QUIET_MS / 2);
        sceneShadow._handleDeviceState(KITCHEN_TOPIC, { power: 'ON', brightness: 40 + i });
    }

    const publishCountDuringPokes = publishesFor('apollo/home/scene/livingRoom/state').length;
    assert.strictEqual(publishCountDuringPokes, 1, 'should not have finalized yet while still being poked');

    await sleep(WAIT_MS);

    const pub = lastPublishFor('apollo/home/scene/livingRoom/state');
    assert.deepStrictEqual(pub.payload.fingerprint, {
        [KITCHEN_TOPIC]: { power: 'ON', brightness: 42 },
    });
});

test('re-activating a scene before settle cancels the prior learning session', async () => {
    sceneShadow._handleDeviceState(KITCHEN_TOPIC, { power: 'OFF', brightness: 0 });
    sceneShadow.onSceneActivated('livingRoom', 'on');
    sceneShadow._handleDeviceState(KITCHEN_TOPIC, { power: 'ON', brightness: 60 });

    // Turn off again before the settle timer fires.
    sceneShadow.onSceneActivated('livingRoom', 'off');

    await sleep(WAIT_MS);

    const pub = lastPublishFor('apollo/home/scene/livingRoom/state');
    assert.strictEqual(pub.payload.active, false, 'should remain off -- the canceled learning session must not resurrect it');
    assert.deepStrictEqual(pub.payload.fingerprint, {});
});

// --- Drift detection ---

test('a member drifting outside tolerance flips the scene to active:false and republishes', async () => {
    sceneShadow._handleDeviceState(KITCHEN_TOPIC, { power: 'OFF', brightness: 0 });
    sceneShadow.onSceneActivated('livingRoom', 'on');
    sceneShadow._handleDeviceState(KITCHEN_TOPIC, { power: 'ON', brightness: 60 });
    await sleep(WAIT_MS);

    assert.strictEqual(lastPublishFor('apollo/home/scene/livingRoom/state').payload.active, true);

    // Someone manually dims the kitchen light well outside the ±3 tolerance.
    sceneShadow._handleDeviceState(KITCHEN_TOPIC, { power: 'ON', brightness: 10 });

    const pub = lastPublishFor('apollo/home/scene/livingRoom/state');
    assert.strictEqual(pub.payload.active, false);
});

test('a member power change (exact-match field) also counts as drift', async () => {
    sceneShadow._handleDeviceState(KITCHEN_TOPIC, { power: 'OFF', brightness: 0 });
    sceneShadow.onSceneActivated('livingRoom', 'on');
    sceneShadow._handleDeviceState(KITCHEN_TOPIC, { power: 'ON', brightness: 60 });
    await sleep(WAIT_MS);

    sceneShadow._handleDeviceState(KITCHEN_TOPIC, { power: 'OFF', brightness: 60 });

    const pub = lastPublishFor('apollo/home/scene/livingRoom/state');
    assert.strictEqual(pub.payload.active, false);
});

test('a brightness change within ±3 tolerance does NOT count as drift', async () => {
    sceneShadow._handleDeviceState(KITCHEN_TOPIC, { power: 'OFF', brightness: 0 });
    sceneShadow.onSceneActivated('livingRoom', 'on');
    sceneShadow._handleDeviceState(KITCHEN_TOPIC, { power: 'ON', brightness: 60 });
    await sleep(WAIT_MS);

    const publishCountBefore = publishesFor('apollo/home/scene/livingRoom/state').length;
    sceneShadow._handleDeviceState(KITCHEN_TOPIC, { power: 'ON', brightness: 62 }); // rounds within tolerance

    assert.strictEqual(
        publishesFor('apollo/home/scene/livingRoom/state').length,
        publishCountBefore,
        'no republish should happen for a within-tolerance reading'
    );
    // Sanity: it really is still considered active (next real drift still flips it).
    sceneShadow._handleDeviceState(KITCHEN_TOPIC, { power: 'ON', brightness: 90 });
    assert.strictEqual(lastPublishFor('apollo/home/scene/livingRoom/state').payload.active, false);
});

test('a change on a non-member device does NOT flip an active scene', async () => {
    sceneShadow._handleDeviceState(KITCHEN_TOPIC, { power: 'OFF', brightness: 0 });
    sceneShadow.onSceneActivated('livingRoom', 'on');
    sceneShadow._handleDeviceState(KITCHEN_TOPIC, { power: 'ON', brightness: 60 });
    await sleep(WAIT_MS);

    const publishCountBefore = publishesFor('apollo/home/scene/livingRoom/state').length;

    // UNRELATED_TOPIC never appeared in the fingerprint (it wasn't touched
    // during learning), so changing it must not affect this scene at all.
    sceneShadow._handleDeviceState(UNRELATED_TOPIC, { power: 'ON', brightness: 100 });

    assert.strictEqual(
        publishesFor('apollo/home/scene/livingRoom/state').length,
        publishCountBefore,
        'non-member change should not trigger a republish'
    );
    assert.strictEqual(lastPublishFor('apollo/home/scene/livingRoom/state').payload.active, true);
});

test('two scenes learn and track independent fingerprints (movie-mode vs bedtime, only one touches the kitchen light)', async () => {
    sceneShadow._handleDeviceState(KITCHEN_TOPIC, { power: 'OFF', brightness: 0 });
    sceneShadow._handleDeviceState(GIANTP_TOPIC, { power: 'OFF', brightness: 0 });

    sceneShadow.onSceneActivated('movieMode', 'on');
    sceneShadow._handleDeviceState(KITCHEN_TOPIC, { power: 'ON', brightness: 20 });
    await sleep(WAIT_MS);

    assert.deepStrictEqual(lastPublishFor('apollo/home/scene/movieMode/state').payload.fingerprint, {
        [KITCHEN_TOPIC]: { power: 'ON', brightness: 20 },
    });

    // bedtime only touches giantP -- kitchen (already settled ON/20 from
    // movieMode) is untouched during bedtime's own learning window, so it
    // must not show up in bedtime's fingerprint.
    sceneShadow.onSceneActivated('bedtime', 'on');
    sceneShadow._handleDeviceState(GIANTP_TOPIC, { power: 'ON', brightness: 80 });
    await sleep(WAIT_MS);

    assert.deepStrictEqual(lastPublishFor('apollo/home/scene/bedtime/state').payload.fingerprint, {
        [GIANTP_TOPIC]: { power: 'ON', brightness: 80 },
    });
    assert.strictEqual(lastPublishFor('apollo/home/scene/movieMode/state').payload.active, true, 'unaffected by bedtime activating');

    // Turning bedtime off must not touch movieMode.
    sceneShadow.onSceneActivated('bedtime', 'off');
    assert.strictEqual(lastPublishFor('apollo/home/scene/movieMode/state').payload.active, true);

    // Drifting movieMode's member (kitchen) flips only movieMode -- bedtime
    // has no fingerprint entry for that topic (and is off besides).
    sceneShadow._handleDeviceState(KITCHEN_TOPIC, { power: 'OFF', brightness: 20 });
    assert.strictEqual(lastPublishFor('apollo/home/scene/movieMode/state').payload.active, false);
    assert.strictEqual(lastPublishFor('apollo/home/scene/bedtime/state').payload.active, false); // still off from the explicit off above
});

// --- Macros: boolean only, no fingerprint ---

test('macro on publishes active:true with no fingerprint field', () => {
    sceneShadow.onMacroActivated('studio', 'on');

    const pub = lastPublishFor('apollo/home/macro/studio/state');
    assert.strictEqual(pub.payload.active, true);
    assert.strictEqual(pub.payload.source, 'command');
    assert.ok(!('fingerprint' in pub.payload), 'macros must not carry a fingerprint field');
    assert.deepStrictEqual(pub.opts, { qos: 1, retain: true });
});

test('macro off publishes active:false with no fingerprint field', () => {
    sceneShadow.onMacroActivated('studio', 'on');
    sceneShadow.onMacroActivated('studio', 'off');

    const pub = lastPublishFor('apollo/home/macro/studio/state');
    assert.strictEqual(pub.payload.active, false);
    assert.ok(!('fingerprint' in pub.payload));
});

test('macro activation never starts fingerprint learning (no settle-window publish follows)', async () => {
    sceneShadow.onMacroActivated('studio', 'on');
    sceneShadow._handleDeviceState(KITCHEN_TOPIC, { power: 'ON', brightness: 60 });
    await sleep(WAIT_MS);

    assert.strictEqual(
        publishesFor('apollo/home/macro/studio/state').length,
        1,
        'macro state should publish exactly once for the activation, nothing more'
    );
});

// --- Malformed payload defensiveness ---

test('_handleDeviceState never throws on malformed payloads', () => {
    assert.doesNotThrow(() => sceneShadow._handleDeviceState(KITCHEN_TOPIC, null));
    assert.doesNotThrow(() => sceneShadow._handleDeviceState(KITCHEN_TOPIC, 'not-an-object'));
    assert.doesNotThrow(() => sceneShadow._handleDeviceState(KITCHEN_TOPIC, undefined));
});
