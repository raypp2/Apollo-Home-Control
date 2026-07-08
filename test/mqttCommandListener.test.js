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

const { _init, _handleDelta, startCommandListener } = require('../src/mqttCommandListener');

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
let publishCalls;

function fakeHandleRequest(commandPath) {
    calls.push(commandPath);
}

function fakePublish(topic, payload, opts) {
    publishCalls.push({ topic, payload, opts });
}

function initWith(commandSource, publish) {
    calls = [];
    publishCalls = [];
    _init({
        subscribe: () => {},
        triggers: FIXTURE_TRIGGERS,
        handleRequest: fakeHandleRequest,
        publish: publish || fakePublish,
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

// --- Desired-field clearing (issue #23 parallel-run fix) ---
//
// AWS IoT shadow `desired` is a sticky setpoint, not a transient command: once
// this listener has handled a delta's fields (logged it, and in shadow mode
// executed it), it must null those exact fields back out of `desired` so a
// later, unrelated reported update doesn't leave them permanently diverged
// (which would make IoT re-emit the same stale delta forever). See
// clearDesiredFields() in src/mqttCommandListener.js for the full reasoning.

test('sqs mode: a single-field delta clears exactly that field from desired via doPublish', () => {
    initWith('sqs');
    _handleDelta('$aws/things/apollo-kitchenLight/shadow/update/delta', deltaPayload({ brightness: 50 }, { version: 20 }));

    assert.strictEqual(calls.length, 0, 'sqs mode must not execute');
    assert.strictEqual(publishCalls.length, 1);
    assert.deepStrictEqual(publishCalls[0], {
        topic: '$aws/things/apollo-kitchenLight/shadow/update',
        payload: { state: { desired: { brightness: null } } },
        opts: { qos: 1, retain: false },
    });
});

test('shadow mode: a single-field delta clears exactly that field from desired via doPublish', () => {
    initWith('shadow');
    _handleDelta('$aws/things/apollo-kitchenLight/shadow/update/delta', deltaPayload({ brightness: 50 }, { version: 20 }));

    assert.deepStrictEqual(calls, ['/LIGHTS/kitchenLight/50']);
    assert.strictEqual(publishCalls.length, 1);
    assert.deepStrictEqual(publishCalls[0], {
        topic: '$aws/things/apollo-kitchenLight/shadow/update',
        payload: { state: { desired: { brightness: null } } },
        opts: { qos: 1, retain: false },
    });
});

test('a multi-field delta clears BOTH fields from desired in one publish', () => {
    initWith('shadow');
    _handleDelta(
        '$aws/things/apollo-kitchenLight/shadow/update/delta',
        deltaPayload({ power: 'ON', brightness: 50 }, { version: 21 })
    );

    assert.strictEqual(publishCalls.length, 1);
    assert.deepStrictEqual(publishCalls[0].payload, { state: { desired: { power: null, brightness: null } } });
    assert.strictEqual(publishCalls[0].topic, '$aws/things/apollo-kitchenLight/shadow/update');
    assert.deepStrictEqual(publishCalls[0].opts, { qos: 1, retain: false });
});

test('shadow mode: execution happens before the desired-clear publish', () => {
    initWith('shadow');
    const order = [];
    _init({
        subscribe: () => {},
        triggers: FIXTURE_TRIGGERS,
        handleRequest: (commandPath) => order.push(`exec:${commandPath}`),
        publish: (topic) => order.push(`publish:${topic}`),
        commandSource: 'shadow',
    });

    _handleDelta('$aws/things/apollo-kitchenLight/shadow/update/delta', deltaPayload({ power: 'ON' }, { version: 22 }));

    assert.deepStrictEqual(order, [
        'exec:/LIGHTS/kitchenLight/on',
        'publish:$aws/things/apollo-kitchenLight/shadow/update',
    ]);
});

test('a throwing doPublish (desired-clear failure) is caught and does not escape the handler, and shadow-mode execution still happened', () => {
    calls = [];
    _init({
        subscribe: () => {},
        triggers: FIXTURE_TRIGGERS,
        handleRequest: fakeHandleRequest,
        publish: () => {
            throw new Error('broker offline');
        },
        commandSource: 'shadow',
    });

    assert.doesNotThrow(() => {
        _handleDelta('$aws/things/apollo-kitchenLight/shadow/update/delta', deltaPayload({ power: 'ON' }, { version: 23 }));
    });
    assert.deepStrictEqual(calls, ['/LIGHTS/kitchenLight/on'], 'the command must still have executed');
});

test('a throwing doPublish in sqs mode is also caught and does not escape the handler', () => {
    _init({
        subscribe: () => {},
        triggers: FIXTURE_TRIGGERS,
        handleRequest: fakeHandleRequest,
        publish: () => {
            throw new Error('broker offline');
        },
        commandSource: 'sqs',
    });

    assert.doesNotThrow(() => {
        _handleDelta('$aws/things/apollo-kitchenLight/shadow/update/delta', deltaPayload({ power: 'ON' }, { version: 24 }));
    });
});

test('the default no-op publish (no `publish` dep injected) does not perturb existing behavior', () => {
    calls = [];
    _init({
        subscribe: () => {},
        triggers: FIXTURE_TRIGGERS,
        handleRequest: fakeHandleRequest,
        commandSource: 'shadow',
    });

    assert.doesNotThrow(() => {
        _handleDelta('$aws/things/apollo-kitchenLight/shadow/update/delta', deltaPayload({ power: 'ON' }, { version: 25 }));
    });
    assert.deepStrictEqual(calls, ['/LIGHTS/kitchenLight/on']);
});

// --- Regression: a failed triggers.json load must not be cached as empty ---
//
// Reproduces the startup race this module is being fixed for: alexaTriggers.js
// used to write config/triggers.json asynchronously, so the very first
// synchronous read here (via ensureInit(), from index.js's startup sequence)
// could race ahead of the write and see a truncated/missing file. The bug was
// that a failed read got cached as a permanently-empty endpoint index --
// `initialized = true` was set unconditionally, so no later delta ever got a
// chance to re-read the (by-then complete) file. This test drives the real
// ensureInit()/loadTriggersIfNeeded() path (via _init's `diskLoader` seam,
// since the normal `_init(...)` shortcut bypasses ensureInit entirely) to
// prove: a delta during the failure window resolves nothing, but a delta
// after triggers.json becomes readable resolves and executes correctly --
// without a restart -- and the one-time COMMAND_SOURCE startup log still
// fires exactly once despite the retry.

/**
 * A controllable stand-in for loadTriggersFromDisk(): returns null (read
 * failure) until recover() is called, then returns a real endpointId -> trigger
 * Map built from `trigger`, mirroring loadTriggersFromDisk()'s success/failure
 * contract (Map on success, null on failure).
 */
function makeFlakyDiskLoader(trigger) {
    let succeed = false;
    return {
        loader: () => {
            if (!succeed) {
                return null;
            }
            const map = new Map();
            map.set(trigger.endpointId, trigger);
            return map;
        },
        recover: () => {
            succeed = true;
        },
    };
}

test('a triggers.json load that fails on startup is retried per-delta (not cached as empty), and COMMAND_SOURCE logs exactly once', () => {
    const flaky = makeFlakyDiskLoader(DIMMABLE_LIGHT);
    calls = [];

    const logs = [];
    const originalLog = console.log;
    console.log = (...args) => logs.push(util.format(...args));

    const hadCommandSource = Object.prototype.hasOwnProperty.call(process.env, 'COMMAND_SOURCE');
    const originalCommandSource = process.env.COMMAND_SOURCE;
    process.env.COMMAND_SOURCE = 'shadow';

    try {
        // diskLoader mode leaves initialized/triggersLoaded false so the real
        // ensureInit() (subscribe + COMMAND_SOURCE log + triggers load) runs
        // for real via startCommandListener(), instead of being short-circuited
        // the way the plain _init({ triggers: [...] }) fixture path is.
        _init({ handleRequest: fakeHandleRequest, diskLoader: flaky.loader });
        startCommandListener(fakeHandleRequest);

        // Startup-time read fails (simulates the truncated/missing file mid-write):
        // the endpoint can't resolve, so nothing executes.
        _handleDelta('$aws/things/apollo-kitchenLight/shadow/update/delta', deltaPayload({ power: 'ON' }, { version: 1 }));
        assert.strictEqual(calls.length, 0, 'must not execute while triggers.json is unreadable');

        // triggers.json is now complete on disk (e.g. alexaTriggers.js's
        // synchronous write has landed).
        flaky.recover();

        // A later delta retries the load, resolves the endpoint, and executes --
        // proving the earlier failure was not cached as a permanent empty index.
        _handleDelta('$aws/things/apollo-kitchenLight/shadow/update/delta', deltaPayload({ power: 'OFF' }, { version: 2 }));
        assert.deepStrictEqual(
            calls,
            ['/LIGHTS/kitchenLight/off'],
            'must resolve and execute once triggers.json becomes readable, without needing a restart'
        );
    } finally {
        console.log = originalLog;
        if (hadCommandSource) {
            process.env.COMMAND_SOURCE = originalCommandSource;
        } else {
            delete process.env.COMMAND_SOURCE;
        }
    }

    const commandSourceLogs = logs.filter((l) => l.includes('COMMAND_SOURCE='));
    assert.strictEqual(
        commandSourceLogs.length,
        1,
        `COMMAND_SOURCE startup log must fire exactly once across retries, got: ${JSON.stringify(commandSourceLogs)}`
    );
});
