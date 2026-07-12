/**
 * Unit tests for src/somfyBridge.js's MQTT listener (startSomfyListener /
 * _handlePosition / _handleDirection / _handleBridgeStatus) and its
 * command-time motion-state publish (_publishCommandMotionState).
 *
 * Test-instrumentation approach: somfyBridge.js exports its subscribe
 * callbacks directly as `_handlePosition(topic, payload)`,
 * `_handleDirection(topic, payload)`, and `_handleBridgeStatus(topic,
 * payload)`, mirroring lightingShelly.js's `_handleSwitchStatus` /
 * `_handleOnline` pattern (see that module's test file for the rationale --
 * there is no interesting dispatch/matching logic living in somfyBridge.js
 * itself; that already lives in, and is already tested by, mqttClient's
 * topicMatches). `_publishCommandMotionState(entry, id, command)` is
 * send_somfy_command's own command-time publish logic, extracted so it's
 * testable directly with a fixture `entry` -- without an HTTP call or
 * booting index.js (send_somfy_command itself calls out to `../index` via
 * findDeviceByAddress() first, which is NOT exercised by these tests; only
 * the extracted, already-resolved-entry logic is).
 *
 * mqttTopics.js is wired to fixture devices via `_init({ lights, devices,
 * publish })`, exactly like test/mqttTopics.test.js and
 * test/lightingShelly.test.js, so requiring this file never boots index.js.
 *
 * No broker involved -- these are pure unit tests.
 */

const assert = require('node:assert');
const { test, beforeEach } = require('node:test');

const mqttTopics = require('../src/mqttTopics');
const { _handlePosition, _handleDirection, _handleBridgeStatus, _publishCommandMotionState } = require('../src/somfyBridge');

let published;

function fakePublish(topic, payload, opts) {
    published.push({ topic, payload, opts });
}

// The real config entry: devices.json's single "shades" entry, location
// "living-room", no mqttName override (falls back to id "shades") -- its
// canonical topic is `apollo/living-room/somfy/shades/state`, which aligns
// EXACTLY with the bridge's native `<root>/shades/...` prefix.
const shades = {
    id: 'shades',
    type: 'Somfy-Bridge',
    address: '192.168.20.13',
    location: 'living-room',
};

// A decoy entry in a different location/ecosystem to prove resolution is by
// FULL topic prefix, not by name or type alone.
const kitchenPlug = {
    id: 'kitchenPlug',
    type: 'shelly',
    address: '10.0.0.11',
    location: 'kitchen',
    mqttName: 'plug',
};

// A second "shades" entry, WITH a full `commands` map (group id 4, named
// individual shades one/two/three -> ids 3/2/1) -- separate from `shades`
// above (which deliberately has no `commands`, so its ids 1-3 stay
// "untracked" for the existing tests below). Needed for the individual-
// shade / movingShades / group-stop-member-sync coverage: those need real
// id->name resolution, which shadeIdMapping() derives entirely from
// `commands` (see its doc comment in somfyBridge.js).
// `id` must be literally "shades" (not e.g. "shadesNamed"), same as the
// `shades` fixture above -- resolveShadeEntry() reconstructs the topic
// prefix straight off the native `apollo/<location>/somfy/shades/...` topic
// and looks for a config entry whose OWN canonical topic (built from its
// `mqttName || id`) matches exactly; a differently-named id would 404.
// Distinguished from `shades` by `location` instead.
const shadesNamed = {
    id: 'shades',
    type: 'Somfy-Bridge',
    address: '192.168.20.14',
    location: 'family-room',
    commands: { on: '4', off: '4', all: '4', one: '3', two: '2', three: '1' },
};

// A THIRD entry, identical shape to shadesNamed, but at its own location so
// its positionsCache slot is guaranteed never touched by any other test in
// this file -- needed for the one assertion that specifically depends on no
// current position being cached yet (positionsCache is a module-level Map,
// not reset by beforeEach, so reusing shadesNamed there would make the test
// order-dependent on whatever ran before it).
const shadesUnprimed = {
    id: 'shades',
    type: 'Somfy-Bridge',
    address: '192.168.20.15',
    location: 'den',
    commands: { on: '4', off: '4', all: '4', one: '3', two: '2', three: '1' },
};

beforeEach(() => {
    published = [];
    mqttTopics._init({
        lights: [kitchenPlug],
        devices: [shades, shadesNamed, shadesUnprimed],
        publish: fakePublish,
    });
});

// --- _handlePosition: shade 4 (tracked) ---

test('position on shade 4 resolves via prefix and publishes canonical state', () => {
    const topic = 'apollo/living-room/somfy/shades/4/position';

    _handlePosition(topic, 55);

    assert.strictEqual(published.length, 1);
    assert.strictEqual(published[0].topic, 'apollo/living-room/somfy/shades/state');
    assert.strictEqual(published[0].payload.position, 55);
    assert.strictEqual(published[0].payload.source, 'event');
});

test('position 0 (open/up) and 100 (closed/down) are both valid boundary values', () => {
    _handlePosition('apollo/living-room/somfy/shades/4/position', 0);
    assert.strictEqual(published[0].payload.position, 0);

    _handlePosition('apollo/living-room/somfy/shades/4/position', 100);
    assert.strictEqual(published[1].payload.position, 100);
});

// --- _handlePosition: shades 1-3 (untracked) ---

test('shade 1 position is ignored (no publish)', () => {
    _handlePosition('apollo/living-room/somfy/shades/1/position', 42);
    assert.strictEqual(published.length, 0);
});

test('shade 2 position is ignored (no publish)', () => {
    _handlePosition('apollo/living-room/somfy/shades/2/position', 42);
    assert.strictEqual(published.length, 0);
});

test('shade 3 position is ignored (no publish)', () => {
    _handlePosition('apollo/living-room/somfy/shades/3/position', 42);
    assert.strictEqual(published.length, 0);
});

// --- _handlePosition: malformed payloads ---

test('non-numeric payload is ignored, not thrown', () => {
    assert.doesNotThrow(() => {
        _handlePosition('apollo/living-room/somfy/shades/4/position', 'not-a-number');
    });
    assert.strictEqual(published.length, 0);
});

test('object payload is ignored, not thrown', () => {
    assert.doesNotThrow(() => {
        _handlePosition('apollo/living-room/somfy/shades/4/position', { unexpected: 'shape' });
    });
    assert.strictEqual(published.length, 0);
});

test('null payload is ignored, not thrown', () => {
    assert.doesNotThrow(() => {
        _handlePosition('apollo/living-room/somfy/shades/4/position', null);
    });
    assert.strictEqual(published.length, 0);
});

test('out-of-range payload (negative) is ignored, not thrown', () => {
    assert.doesNotThrow(() => {
        _handlePosition('apollo/living-room/somfy/shades/4/position', -1);
    });
    assert.strictEqual(published.length, 0);
});

test('out-of-range payload (>100) is ignored, not thrown', () => {
    assert.doesNotThrow(() => {
        _handlePosition('apollo/living-room/somfy/shades/4/position', 101);
    });
    assert.strictEqual(published.length, 0);
});

// --- _handlePosition: unknown location / no config entry ---

test('unknown location (no matching config entry) is logged, not thrown, and does not publish', () => {
    assert.doesNotThrow(() => {
        _handlePosition('apollo/attic/somfy/shades/4/position', 50);
    });
    assert.strictEqual(published.length, 0);
});

// --- _handleBridgeStatus: bridge-level LWT ---

test('status "offline" marks the shades entry unreachable via publishUnreachable', () => {
    // Seed prior state so we can prove publishUnreachable preserves it.
    _handlePosition('apollo/living-room/somfy/shades/4/position', 30);
    published = [];

    _handleBridgeStatus('apollo/living-room/somfy/status', 'offline');

    assert.strictEqual(published.length, 1);
    assert.strictEqual(published[0].topic, 'apollo/living-room/somfy/shades/state');
    assert.strictEqual(published[0].payload.reachable, false);
    assert.strictEqual(published[0].payload.position, 30, 'prior position should be preserved by publishUnreachable\'s merge');
});

test('status "online" is a no-op (per-shade position messages follow on their own)', () => {
    _handleBridgeStatus('apollo/living-room/somfy/status', 'online');
    assert.strictEqual(published.length, 0);
});

test('unrecognized status payload is ignored, not thrown', () => {
    assert.doesNotThrow(() => {
        _handleBridgeStatus('apollo/living-room/somfy/status', { unexpected: 'shape' });
    });
    assert.strictEqual(published.length, 0);
});

test('status "offline" for an unknown location is logged, not thrown', () => {
    assert.doesNotThrow(() => {
        _handleBridgeStatus('apollo/attic/somfy/status', 'offline');
    });
    assert.strictEqual(published.length, 0);
});

// --- _publishCommandMotionState: command-time publish (never the final
// position -- see the module doc comment) ---

test('group ON command publishes moving:down + target:100, never touches position', () => {
    _publishCommandMotionState(shadesNamed, '4', 'ON');

    assert.strictEqual(published.length, 1);
    assert.strictEqual(published[0].topic, 'apollo/family-room/somfy/shades/state');
    assert.strictEqual(published[0].payload.moving, 'down');
    assert.strictEqual(published[0].payload.target, 100);
    assert.strictEqual(published[0].payload.movingShades.length, 3);
    assert.deepStrictEqual(published[0].payload.movingShades.sort(), ['one', 'three', 'two']);
    assert.strictEqual(published[0].payload.position, undefined, 'command-time publish must never claim a position');
    assert.strictEqual(published[0].payload.source, 'command');
});

test('falsy command (no command passed) is treated as ON/down, same as an explicit "ON"', () => {
    _publishCommandMotionState(shadesNamed, '4', undefined);

    assert.strictEqual(published[0].payload.moving, 'down');
    assert.strictEqual(published[0].payload.target, 100);
});

test('group OFF command publishes moving:up + target:0', () => {
    _publishCommandMotionState(shadesNamed, '4', 'OFF');

    assert.strictEqual(published[0].payload.moving, 'up');
    assert.strictEqual(published[0].payload.target, 0);
});

test('STOP command publishes moving:null and target:null (explicit clear, not omission)', () => {
    // Seed prior motion so we can prove STOP actually clears it rather than
    // just never having set it.
    _publishCommandMotionState(shadesNamed, '4', 'ON');
    published = [];

    _publishCommandMotionState(shadesNamed, '4', 'STOP');

    assert.strictEqual(published.length, 1);
    assert.strictEqual(published[0].payload.moving, null);
    assert.strictEqual(published[0].payload.target, null);
});

test('individual shade command ("one") only reports that shade in movingShades', () => {
    _publishCommandMotionState(shadesNamed, '3', 'OFF'); // id 3 = "one"

    assert.strictEqual(published[0].payload.moving, 'up');
    assert.strictEqual(published[0].payload.target, 0);
    assert.deepStrictEqual(published[0].payload.movingShades, ['one']);
});

test('numeric target above a KNOWN current position infers moving:down', () => {
    // Seed a known current position via a real position event (id 4 = group).
    _handlePosition('apollo/family-room/somfy/shades/4/position', 20);
    published = [];

    _publishCommandMotionState(shadesNamed, '4', '70');

    assert.strictEqual(published[0].payload.moving, 'down');
    assert.strictEqual(published[0].payload.target, 70);
});

test('numeric target below a KNOWN current position infers moving:up', () => {
    _handlePosition('apollo/family-room/somfy/shades/4/position', 70);
    published = [];

    _publishCommandMotionState(shadesNamed, '4', '20');

    assert.strictEqual(published[0].payload.moving, 'up');
    assert.strictEqual(published[0].payload.target, 20);
});

test('numeric target equal to a KNOWN current position infers moving:null (already there)', () => {
    _handlePosition('apollo/family-room/somfy/shades/4/position', 50);
    published = [];

    _publishCommandMotionState(shadesNamed, '4', '50');

    assert.strictEqual(published[0].payload.moving, null);
    assert.strictEqual(published[0].payload.target, 50);
});

test('numeric target with an UNKNOWN current position omits moving (left for the direction event)', () => {
    // shadesUnprimed's cache slot has never been touched by any earlier test
    // (see its doc comment above) -- this is the only reliable way to assert
    // "no cached current position yet" against a positionsCache that
    // persists across tests in this file.
    _publishCommandMotionState(shadesUnprimed, '4', '50');

    assert.strictEqual(published[0].payload.target, 50);
    assert.strictEqual(published[0].payload.moving, undefined);
});

test('numeric target for an individual shade compares against that shade\'s own cached position, not the group\'s', () => {
    // Seed shade "one" (id 3) at 10 via a real position event.
    _handlePosition('apollo/family-room/somfy/shades/3/position', 10);
    published = [];

    _publishCommandMotionState(shadesNamed, '3', '90');

    assert.strictEqual(published[0].payload.moving, 'down');
    assert.strictEqual(published[0].payload.target, 90);
});

test('unrecognized shade id publishes nothing', () => {
    _publishCommandMotionState(shadesNamed, '99', 'ON');
    assert.strictEqual(published.length, 0);
});

test('command-time publish is self-contained: a later position event carries moving/target forward', () => {
    _publishCommandMotionState(shadesNamed, '4', 'ON');
    published = [];

    _handlePosition('apollo/family-room/somfy/shades/4/position', 42);

    assert.strictEqual(published.length, 1);
    assert.strictEqual(published[0].payload.position, 42);
    assert.strictEqual(published[0].payload.moving, 'down', 'position tick must not drop the in-flight moving state');
    assert.strictEqual(published[0].payload.target, 100);
});

// --- _handleDirection ---

test('direction 1 (closing) on the group publishes moving:down for every named member', () => {
    _handleDirection('apollo/family-room/somfy/shades/4/direction', 1);

    assert.strictEqual(published.length, 1);
    assert.strictEqual(published[0].payload.moving, 'down');
    assert.deepStrictEqual(published[0].payload.movingShades.sort(), ['one', 'three', 'two']);
    assert.strictEqual(published[0].payload.source, 'event');
});

test('direction -1 (opening) on an individual shade publishes moving:up for just that shade', () => {
    _handleDirection('apollo/family-room/somfy/shades/3/direction', -1); // id 3 = "one"

    assert.strictEqual(published[0].payload.moving, 'up');
    assert.deepStrictEqual(published[0].payload.movingShades, ['one']);
});

test('direction 0 (stopped) clears moving/target/movingShades', () => {
    _handleDirection('apollo/family-room/somfy/shades/4/direction', 1);
    _publishCommandMotionState(shadesNamed, '4', '80'); // sets a target to prove it gets cleared
    published = [];

    _handleDirection('apollo/family-room/somfy/shades/4/direction', 0);

    assert.strictEqual(published.length, 1);
    assert.strictEqual(published[0].payload.moving, null);
    assert.strictEqual(published[0].payload.target, null);
    assert.deepStrictEqual(published[0].payload.movingShades, []);
});

test('direction 0 on the GROUP snapshots the group\'s final position onto every named member (one-way RTS never reports member positions for a group move)', () => {
    _handlePosition('apollo/family-room/somfy/shades/4/position', 85);
    published = [];

    _handleDirection('apollo/family-room/somfy/shades/4/direction', 0);

    assert.strictEqual(published.length, 1);
    assert.deepStrictEqual(published[0].payload.positions, { one: 85, two: 85, three: 85 });
});

test('direction 0 on an INDIVIDUAL shade does NOT touch the other members\' positions', () => {
    _handlePosition('apollo/family-room/somfy/shades/4/position', 85); // seed group position
    _handleDirection('apollo/family-room/somfy/shades/4/direction', 0); // sync members to 85
    published = [];

    _handlePosition('apollo/family-room/somfy/shades/3/position', 15); // "one" moves independently
    _handleDirection('apollo/family-room/somfy/shades/3/direction', 0); // "one" stops

    const last = published[published.length - 1];
    assert.deepStrictEqual(last.payload.positions, { one: 15, two: 85, three: 85 });
});

test('direction on an untracked shade id (no commands map) is ignored, not thrown', () => {
    assert.doesNotThrow(() => {
        _handleDirection('apollo/living-room/somfy/shades/1/direction', 1);
    });
    assert.strictEqual(published.length, 0);
});

test('malformed direction payload (non-numeric) is ignored, not thrown', () => {
    assert.doesNotThrow(() => {
        _handleDirection('apollo/family-room/somfy/shades/4/direction', 'not-a-number');
    });
    assert.strictEqual(published.length, 0);
});

test('malformed direction payload (object) is ignored, not thrown', () => {
    assert.doesNotThrow(() => {
        _handleDirection('apollo/family-room/somfy/shades/4/direction', { unexpected: 'shape' });
    });
    assert.strictEqual(published.length, 0);
});

test('malformed direction payload (out of range, e.g. 2) is ignored, not thrown', () => {
    assert.doesNotThrow(() => {
        _handleDirection('apollo/family-room/somfy/shades/4/direction', 2);
    });
    assert.strictEqual(published.length, 0);
});

test('direction for an unknown location is logged, not thrown, and does not publish', () => {
    assert.doesNotThrow(() => {
        _handleDirection('apollo/attic/somfy/shades/4/direction', 1);
    });
    assert.strictEqual(published.length, 0);
});
