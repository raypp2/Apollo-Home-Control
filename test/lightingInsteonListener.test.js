/**
 * Unit tests for src/lightingInsteonListener.js -- MQTT event publishing,
 * the issue #31 keypad dedupe window, and the staggered round-robin poll
 * sweep (Stage 3 of the MQTT plan).
 *
 * Test-instrumentation approach: mirrors mqttTopics.js's lazy-init pattern
 * (see its own module doc comment, and test/mqttTopics.test.js). Requiring
 * lightingInsteonListener.js used to eagerly `require('../index')` at module
 * scope, which boots the whole Apollo config-loading chain (config/*.json +
 * starts an Express server) as a side effect of merely requiring the file --
 * a real problem observed while writing these tests: doing so under `node
 * --test` hangs the runner because webServer.listen() keeps the event loop
 * alive. lightingInsteonListener.js was refactored to lazily pull `lights`/
 * `insteonKeypad` from '../index' (ensureInit()), with a test-only `_init()`
 * override -- exactly like mqttTopics.js. We call `_init(...)` with fixture
 * arrays before any other call, so requiring this test file never boots
 * index.js.
 *
 * mqttTopics.js itself is wired to fixture lights via its own `_init(...)`.
 *
 * The `home-controller` hub connection is never constructed for real here --
 * `_setHub(fakeHub)` swaps in a fake `{ light: () => ({ level: () =>
 * Promise }) }` for the poll-sweep tests, per the module's `_setHub` test
 * hook (added specifically because pollTick() needs *some* hub to call).
 *
 * Clock strategy: rather than contort the module with an injected clock
 * (pollTick() and isKeypadPress() both read Date.now() directly in a few
 * places, and threading a fake clock through setInterval/setTimeout-adjacent
 * logic added more indirection than it removed), the keypad dedupe window is
 * tested via an injectable window constant: `_setKeypadDedupeWindowForTesting
 * (50)` shrinks the real 3000ms production window to 50ms so the "within
 * window" / "after window" tests use real (but short) waits instead of
 * mocking time. This was explicitly called out as acceptable in the task
 * brief when clock injection would get ugly.
 */

'use strict';

const assert = require('node:assert');
const { test, beforeEach } = require('node:test');

const mqttTopics = require('../src/mqttTopics');
const listener = require('../src/lightingInsteonListener');
const { optimisticStateFor } = require('../src/lightingInsteon');

let published;

function fakePublish(topic, payload, opts) {
    published.push({ topic, payload, opts });
}

// Two insteon lights, matching the config schema documented in
// mqtt-implementation-detail.md (no `location`/`mqttName` overrides -- per
// the task brief, current insteon lights.json entries don't have `location`,
// so topics default to apollo/home/insteon/<id>/state).
const kitchen = {
    id: 'kitchen',
    type: 'insteon',
    address: '2A2A2A',
};

const diningRoom = {
    id: 'diningRoom',
    type: 'insteon',
    address: '3B3B3B',
};

const keypadConfig = [
    {
        device_id: '2A2A2A',
        gateways: [
            { id: 'gw1', name: 'Button A', command_on: 'LIGHTS/kitchen/ON', command_off: 'LIGHTS/kitchen/OFF' },
        ],
    },
];

beforeEach(() => {
    published = [];
    mqttTopics._init({ lights: [kitchen, diningRoom], devices: [], publish: fakePublish });
    listener._init({ lights: [kitchen, diningRoom], insteonKeypad: keypadConfig });
    listener._resetPollStateForTesting();
    listener._resetKeypadStateForTesting();
    listener._setKeypadDedupeWindowForTesting(3000); // restore default unless a test overrides it
    for (const entry of [kitchen, diningRoom]) {
        delete entry.checked;
        delete entry.status;
    }
});

// --- _handleHubCommand: event-sourced state publishing (issue #11) ---

test('command1 "11" (ON) publishes canonical ON state and syncs the in-memory entry', () => {
    listener._handleHubCommand({ standard: { id: '2a2a2a', command1: '11', command2: 'FF' } });

    assert.strictEqual(published.length, 1);
    assert.strictEqual(published[0].topic, 'apollo/home/insteon/kitchen/state');
    assert.strictEqual(published[0].payload.power, 'ON');
    assert.strictEqual(published[0].payload.source, 'event');
    assert.strictEqual(kitchen.checked, true);
    assert.strictEqual(kitchen.status, 100);
});

test('command1 "13" (OFF) publishes canonical OFF state (with brightness:0) and syncs the in-memory entry', () => {
    listener._handleHubCommand({ standard: { id: '2A2A2A', command1: '13', command2: '00' } });

    assert.strictEqual(published.length, 1);
    assert.strictEqual(published[0].payload.power, 'OFF');
    assert.strictEqual(published[0].payload.brightness, 0);
    assert.strictEqual(published[0].payload.source, 'event');
    assert.strictEqual(kitchen.checked, false);
    assert.strictEqual(kitchen.status, 0);
});

test('address match is case-insensitive', () => {
    listener._handleHubCommand({ standard: { id: '3b3b3b', command1: '11' } });
    assert.strictEqual(published.length, 1);
    assert.strictEqual(published[0].topic, 'apollo/home/insteon/diningRoom/state');
});

test('other command1 values (e.g. brighten/dim) are ignored silently, no throw', () => {
    assert.doesNotThrow(() => {
        listener._handleHubCommand({ standard: { id: '2A2A2A', command1: '15', command2: 'FF' } });
    });
    assert.strictEqual(published.length, 0);
    assert.strictEqual(kitchen.checked, undefined);
});

test('non-light address is ignored, no throw, no publish', () => {
    assert.doesNotThrow(() => {
        listener._handleHubCommand({ standard: { id: 'FFFFFF', command1: '11' } });
    });
    assert.strictEqual(published.length, 0);
});

test('malformed info (missing standard/id) is ignored, no throw', () => {
    assert.doesNotThrow(() => listener._handleHubCommand(undefined));
    assert.doesNotThrow(() => listener._handleHubCommand({}));
    assert.doesNotThrow(() => listener._handleHubCommand({ standard: {} }));
    assert.strictEqual(published.length, 0);
});

// --- _handleHubCommand: event follow-up poll for physical ON events ---
// (the switch ramps to a locally-stored level the hub's ON/OFF broadcast
// doesn't carry -- see module doc comment on scheduleEventFollowUpPoll)

test('ON event schedules a follow-up poll that publishes the actual (poll-sourced) brightness', async () => {
    listener._setEventFollowUpPollDelayForTesting(20);
    listener._setHub(fakeHubWithLevels({ '2A2A2A': 62 }));

    listener._handleHubCommand({ standard: { id: '2A2A2A', command1: '11', command2: 'FF' } });

    // Synchronous event publish happens immediately, before the follow-up poll fires.
    assert.strictEqual(published.length, 1);
    assert.strictEqual(published[0].payload.source, 'event');

    await new Promise((resolve) => setTimeout(resolve, 60));

    assert.strictEqual(published.length, 2);
    assert.strictEqual(published[1].topic, 'apollo/home/insteon/kitchen/state');
    assert.strictEqual(published[1].payload.power, 'ON');
    assert.strictEqual(published[1].payload.brightness, 62);
    assert.strictEqual(published[1].payload.source, 'poll');
    assert.strictEqual(kitchen.checked, true);
    assert.strictEqual(kitchen.status, 62);
});

test('OFF event publishes brightness:0 immediately and schedules no follow-up poll', async () => {
    listener._setEventFollowUpPollDelayForTesting(20);
    listener._setHub(fakeHubWithLevels({ '2A2A2A': 62 }));

    listener._handleHubCommand({ standard: { id: '2A2A2A', command1: '13', command2: '00' } });

    assert.strictEqual(published.length, 1);
    assert.strictEqual(published[0].payload.brightness, 0);
    assert.strictEqual(published[0].payload.source, 'event');

    await new Promise((resolve) => setTimeout(resolve, 60));

    // Still just the one OFF publish -- no follow-up poll was scheduled.
    assert.strictEqual(published.length, 1);
});

test('a burst of repeated ON events schedules exactly one follow-up poll', async () => {
    listener._setEventFollowUpPollDelayForTesting(20);
    listener._setHub(fakeHubWithLevels({ '2A2A2A': 45 }));

    listener._handleHubCommand({ standard: { id: '2A2A2A', command1: '11', command2: 'FF' } });
    listener._handleHubCommand({ standard: { id: '2A2A2A', command1: '11', command2: 'FF' } });
    listener._handleHubCommand({ standard: { id: '2A2A2A', command1: '11', command2: 'FF' } });

    // Three synchronous event publishes (one per re-emission)...
    assert.strictEqual(published.length, 3);
    assert.ok(published.every((p) => p.payload.source === 'event'));

    await new Promise((resolve) => setTimeout(resolve, 60));

    // ...but only one poll-sourced follow-up publish.
    const pollPublishes = published.filter((p) => p.payload.source === 'poll');
    assert.strictEqual(pollPublishes.length, 1, 'a burst of identical ON events must only schedule one follow-up poll');
    assert.strictEqual(pollPublishes[0].payload.brightness, 45);
});

test('follow-up poll rejection is caught and logged, never throws or leaves an unhandled rejection', async () => {
    listener._setEventFollowUpPollDelayForTesting(20);
    listener._setHub(fakeHubWithLevels({ '2A2A2A': { reject: 'hub unreachable' } }));

    assert.doesNotThrow(() => {
        listener._handleHubCommand({ standard: { id: '2A2A2A', command1: '11', command2: 'FF' } });
    });

    await new Promise((resolve) => setTimeout(resolve, 60));

    // Only the synchronous event publish -- the failed follow-up poll never published.
    assert.strictEqual(published.length, 1);
    assert.strictEqual(published[0].payload.source, 'event');
});

// --- isKeypadPress: dedupe window (issue #31) ---

test('keypad dedupe: same command re-arriving within the window is suppressed', () => {
    const calls = [];
    const handleRequest = (path) => calls.push(path);

    listener.isKeypadPress({ standard: { id: '2A2A2A', gatewayId: 'gw1', command1: '11', command2: '00' } }, handleRequest);
    listener.isKeypadPress({ standard: { id: '2A2A2A', gatewayId: 'gw1', command1: '11', command2: '00' } }, handleRequest);
    listener.isKeypadPress({ standard: { id: '2A2A2A', gatewayId: 'gw1', command1: '11', command2: '00' } }, handleRequest);

    assert.strictEqual(calls.length, 1, 'the burst-repeat re-emissions should be suppressed');
    assert.strictEqual(calls[0], '/LIGHTS/kitchen/ON');
});

test('keypad dedupe: same command re-arriving after the window elapses runs again', async () => {
    listener._setKeypadDedupeWindowForTesting(50);
    const calls = [];
    const handleRequest = (path) => calls.push(path);

    listener.isKeypadPress({ standard: { id: '2A2A2A', gatewayId: 'gw1', command1: '11', command2: '00' } }, handleRequest);
    await new Promise((resolve) => setTimeout(resolve, 80));
    listener.isKeypadPress({ standard: { id: '2A2A2A', gatewayId: 'gw1', command1: '11', command2: '00' } }, handleRequest);

    assert.strictEqual(calls.length, 2, 'a genuine second press after the window must still run');
});

test('keypad dedupe: a different command is never suppressed, even immediately after another', () => {
    const calls = [];
    const handleRequest = (path) => calls.push(path);

    listener.isKeypadPress({ standard: { id: '2A2A2A', gatewayId: 'gw1', command1: '11', command2: '00' } }, handleRequest);
    listener.isKeypadPress({ standard: { id: '2A2A2A', gatewayId: 'gw1', command1: '13', command2: '00' } }, handleRequest);

    assert.strictEqual(calls.length, 2);
    assert.strictEqual(calls[0], '/LIGHTS/kitchen/ON');
    assert.strictEqual(calls[1], '/LIGHTS/kitchen/OFF');
});

test('keypad press for an unwatched device is a no-op, no throw', () => {
    const calls = [];
    assert.doesNotThrow(() => {
        listener.isKeypadPress({ standard: { id: 'FFFFFF', gatewayId: 'gw1', command1: '11', command2: '00' } }, (p) => calls.push(p));
    });
    assert.strictEqual(calls.length, 0);
});

// --- pollTick: staggered round-robin polling ---

function fakeHubWithLevels(levelsByAddress) {
    return {
        light(address) {
            return {
                level() {
                    const entry = levelsByAddress[address];
                    if (entry && entry.reject) {
                        return Promise.reject(new Error(entry.reject));
                    }
                    return Promise.resolve(entry);
                },
            };
        },
    };
}

test('poll tick publishes poll-sourced state for the current rotation target', async () => {
    listener._setHub(fakeHubWithLevels({ '2A2A2A': 100, '3B3B3B': 0 }));

    listener.pollTick();
    // pollTick's hub call resolves asynchronously (a Promise) -- flush microtasks.
    await new Promise((resolve) => setImmediate(resolve));

    assert.strictEqual(published.length, 1);
    assert.strictEqual(published[0].topic, 'apollo/home/insteon/kitchen/state');
    assert.strictEqual(published[0].payload.power, 'ON');
    assert.strictEqual(published[0].payload.brightness, 100);
    assert.strictEqual(published[0].payload.source, 'poll');
    assert.strictEqual(kitchen.checked, true);
    assert.strictEqual(kitchen.status, 100);
});

test('poll tick round-robins to the next light on the following tick', async () => {
    listener._setHub(fakeHubWithLevels({ '2A2A2A': 100, '3B3B3B': 0 }));

    listener.pollTick();
    await new Promise((resolve) => setImmediate(resolve));
    listener.pollTick();
    await new Promise((resolve) => setImmediate(resolve));

    assert.strictEqual(published.length, 2);
    assert.strictEqual(published[0].topic, 'apollo/home/insteon/kitchen/state');
    assert.strictEqual(published[1].topic, 'apollo/home/insteon/diningRoom/state');
    assert.strictEqual(published[1].payload.power, 'OFF');
    assert.strictEqual(published[1].payload.brightness, 0);
});

test('poll tick skips (does not throw, does not advance) while an outbound command is recent', async () => {
    listener._setHub(fakeHubWithLevels({ '2A2A2A': 100, '3B3B3B': 0 }));
    listener.noteCommandSent();

    listener.pollTick();
    await new Promise((resolve) => setImmediate(resolve));

    assert.strictEqual(published.length, 0, 'polling must back off for 10s after an outbound command');
});

test('poll error is caught, logged once, and triggers a backoff pause without an unhandled rejection', async () => {
    listener._setHub(fakeHubWithLevels({ '2A2A2A': { reject: 'hub unreachable' }, '3B3B3B': 0 }));

    assert.doesNotThrow(() => listener.pollTick());
    await new Promise((resolve) => setImmediate(resolve));

    assert.strictEqual(published.length, 0);

    // Backoff should now suppress further ticks even though the rotation
    // would otherwise have moved to the next (healthy) light.
    listener.pollTick();
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(published.length, 0, 'the 60s hub-outage backoff should suppress the very next tick too');
});

test('poll tick does not stack a second call while a poll is still in flight', async () => {
    let resolveFirst;
    const hangingHub = {
        light() {
            return {
                level() {
                    return new Promise((resolve) => { resolveFirst = resolve; });
                },
            };
        },
    };
    listener._setHub(hangingHub);

    listener.pollTick(); // starts the "hanging" poll, pollInFlight becomes true
    listener.pollTick(); // must be a no-op -- previous poll hasn't settled

    resolveFirst(100);
    await new Promise((resolve) => setImmediate(resolve));

    assert.strictEqual(published.length, 1, 'the stacked second tick must not have started its own hub call');
});

// --- optimisticStateFor (lightingInsteon.js): semantic command -> optimistic state ---

test('optimisticStateFor: ON/FAST-ON map to power ON, brightness 100', () => {
    assert.deepStrictEqual(optimisticStateFor('ON'), { power: 'ON', brightness: 100 });
    assert.deepStrictEqual(optimisticStateFor('FAST-ON'), { power: 'ON', brightness: 100 });
});

test('optimisticStateFor: OFF/FAST-OFF map to power OFF, brightness 0', () => {
    assert.deepStrictEqual(optimisticStateFor('OFF'), { power: 'OFF', brightness: 0 });
    assert.deepStrictEqual(optimisticStateFor('FAST-OFF'), { power: 'OFF', brightness: 0 });
});

test('optimisticStateFor: numeric level maps power from level > 0, brightness = level', () => {
    assert.deepStrictEqual(optimisticStateFor(75), { power: 'ON', brightness: 75 });
    assert.deepStrictEqual(optimisticStateFor(0), { power: 'OFF', brightness: 0 });
    assert.deepStrictEqual(optimisticStateFor('50'), { power: 'ON', brightness: 50 });
});

test('optimisticStateFor: BRIGHTEN/DIM are skipped (relative, unknown result)', () => {
    assert.strictEqual(optimisticStateFor('BRIGHTEN'), null);
    assert.strictEqual(optimisticStateFor('DIM'), null);
});
