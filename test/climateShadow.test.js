/**
 * Unit tests for src/climateShadow.js.
 *
 * Test-instrumentation approach: climateShadow.js exposes `_init({ sendIr,
 * publishState, acEntry, stepSpacingMs })` (mirroring sceneShadow.js's /
 * healthMonitor.js's override hooks), so tests never touch iTachControllers,
 * mqttTopics, or index.js's real config. `stepSpacingMs` is overridden to a
 * few ms so the spaced-IR-send tests don't wait on the real ~600ms spacing --
 * they drive real (but tiny) timers via `await sleep(ms)` rather than faking
 * setTimeout, matching sceneShadow.test.js's approach.
 *
 * No broker, no iTach hardware, no index.js boot -- these are pure unit tests.
 */

const assert = require('node:assert');
const { test, beforeEach } = require('node:test');

const climateShadow = require('../src/climateShadow');

const SPACING_MS = 2;
// Comfortably past however many spaced steps a single test fires at
// SPACING_MS each, so all pending timers have definitely fired.
const WAIT_MS = 100;

const AC_ENTRY = {
    id: 'livingRoomAC',
    address: '10.0.0.50',
    commands: {
        COOL: 'IR_COOL',
        ECO: 'IR_ECO',
        fan_auto: 'IR_FAN_AUTO',
        fan_speed_increase: 'IR_FAN_UP',
        fan_speed_decrease: 'IR_FAN_DOWN',
        temp_increase: 'IR_TEMP_UP',
        temp_decrease: 'IR_TEMP_DOWN',
        on: 'IR_ON',
        off: 'IR_OFF',
    },
};

let sent;
let published;

function fakeSendIr(address, irString, debugId) {
    sent.push({ address, irString, debugId });
}

function fakePublishState(entry, state) {
    published.push({ entry, state: { ...state } });
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function lastPublish() {
    return published[published.length - 1];
}

function commandNames(records) {
    // Map each fake-sendIr record's irString back to the command name it
    // came from, via AC_ENTRY.commands, so assertions read as command names
    // rather than raw IR strings.
    const byIrString = new Map(Object.entries(AC_ENTRY.commands).map(([k, v]) => [v, k]));
    return records.map((r) => byIrString.get(r.irString));
}

beforeEach(() => {
    sent = [];
    published = [];
    climateShadow._resetForTesting();
    climateShadow._init({
        sendIr: fakeSendIr,
        publishState: fakePublishState,
        acEntry: AC_ENTRY,
        stepSpacingMs: SPACING_MS,
    });
});

// --- setSetpoint: absolute -> relative stepping ---

test('setSetpoint from 70 to 74 fires temp_increase x4', async () => {
    climateShadow.override({ setpoint: 70 });
    sent = []; // override sends no IR, but reset defensively

    climateShadow.setSetpoint(74);
    await sleep(WAIT_MS);

    assert.deepStrictEqual(commandNames(sent), Array(4).fill('temp_increase'));
});

test('setSetpoint from 70 to 68 fires temp_decrease x2', async () => {
    climateShadow.override({ setpoint: 70 });
    sent = [];

    climateShadow.setSetpoint(68);
    await sleep(WAIT_MS);

    assert.deepStrictEqual(commandNames(sent), Array(2).fill('temp_decrease'));
});

test('setSetpoint clamps at the 60 floor', async () => {
    climateShadow.override({ setpoint: 62 });
    sent = [];

    const result = climateShadow.setSetpoint(50);
    assert.strictEqual(result.setpoint, 60);

    await sleep(WAIT_MS);
    assert.deepStrictEqual(commandNames(sent), Array(2).fill('temp_decrease'));
});

test('setSetpoint clamps at the 80 ceiling', async () => {
    climateShadow.override({ setpoint: 78 });
    sent = [];

    const result = climateShadow.setSetpoint(999);
    assert.strictEqual(result.setpoint, 80);

    await sleep(WAIT_MS);
    assert.deepStrictEqual(commandNames(sent), Array(2).fill('temp_increase'));
});

test('setSetpoint publishes the target immediately, before IR steps flush', () => {
    climateShadow.override({ setpoint: 70 });
    published = [];
    sent = [];

    climateShadow.setSetpoint(75);

    // Synchronous assertion -- no sleep -- proves the publish happened before
    // any of the spaced setTimeout-scheduled IR sends could have fired.
    assert.strictEqual(lastPublish().state.setpoint, 75);
    assert.strictEqual(sent.length, 0);
});

test('setSetpoint with no change publishes but sends no IR', async () => {
    climateShadow.override({ setpoint: 72 });
    sent = [];

    climateShadow.setSetpoint(72);
    await sleep(WAIT_MS);

    assert.strictEqual(sent.length, 0);
    assert.strictEqual(lastPublish().state.setpoint, 72);
});

// --- setMode ---

test('setMode COOL fires the COOL IR command and publishes', () => {
    climateShadow.setMode('COOL');

    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].irString, AC_ENTRY.commands.COOL);
    assert.strictEqual(lastPublish().state.mode, 'COOL');
});

test('setMode ECO fires the ECO IR command and publishes', () => {
    climateShadow.setMode('eco');

    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].irString, AC_ENTRY.commands.ECO);
    assert.strictEqual(lastPublish().state.mode, 'ECO');
});

test('setMode ignores an unknown mode', () => {
    climateShadow.override({ mode: 'COOL' });
    sent = [];
    published = [];

    const result = climateShadow.setMode('HEAT');

    assert.strictEqual(sent.length, 0);
    assert.strictEqual(published.length, 0);
    assert.strictEqual(result.mode, 'COOL');
});

// --- setPower ---

// Published power is the 'ON'/'OFF' wire convention shared with every other
// device state topic; the shadow's internal boolean never leaves the module.
test('setPower(true) fires "on" and publishes power:"ON"', () => {
    climateShadow.setPower(true);

    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].irString, AC_ENTRY.commands.on);
    assert.strictEqual(lastPublish().state.power, 'ON');
});

test('setPower(false) fires "off" and publishes power:"OFF"', () => {
    climateShadow.setPower(false);

    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].irString, AC_ENTRY.commands.off);
    assert.strictEqual(lastPublish().state.power, 'OFF');
});

// --- setFan: ladder + auto transitions ---

test('setFan steps up the ladder from low to high (2 increases)', async () => {
    climateShadow.override({ fan: 'low' });
    sent = [];

    climateShadow.setFan('high');
    await sleep(WAIT_MS);

    assert.deepStrictEqual(commandNames(sent), Array(2).fill('fan_speed_increase'));
});

test('setFan steps down the ladder from high to low (2 decreases)', async () => {
    climateShadow.override({ fan: 'high' });
    sent = [];

    climateShadow.setFan('low');
    await sleep(WAIT_MS);

    assert.deepStrictEqual(commandNames(sent), Array(2).fill('fan_speed_decrease'));
});

test('setFan to auto fires a single fan_auto, regardless of current speed', async () => {
    climateShadow.override({ fan: 'high' });
    sent = [];

    climateShadow.setFan('auto');
    await sleep(WAIT_MS);

    assert.deepStrictEqual(commandNames(sent), ['fan_auto']);
});

test('setFan from auto to med anchors with fan_auto then steps up to the target', async () => {
    climateShadow.override({ fan: 'auto' });
    sent = [];

    climateShadow.setFan('med');
    await sleep(WAIT_MS);

    // med is ordinal 1 -> anchor + 2 increases (see fanCommandSequence doc comment)
    assert.deepStrictEqual(commandNames(sent), ['fan_auto', 'fan_speed_increase', 'fan_speed_increase']);
});

test('setFan is a no-op when already at the target', async () => {
    climateShadow.override({ fan: 'med' });
    sent = [];

    climateShadow.setFan('med');
    await sleep(WAIT_MS);

    assert.strictEqual(sent.length, 0);
});

test('setFan publishes the target fan speed immediately (optimistic)', () => {
    climateShadow.override({ fan: 'low' });
    published = [];
    sent = [];

    climateShadow.setFan('high');

    assert.strictEqual(lastPublish().state.fan, 'high');
    assert.strictEqual(sent.length, 0);
});

// --- override: drift correction, no IR ---

test('override updates every given field, publishes, and sends no IR', () => {
    const result = climateShadow.override({ power: true, mode: 'ECO', setpoint: 68, fan: 'low' });

    assert.strictEqual(sent.length, 0);
    // getState()/override() return the internal boolean; the publish carries
    // the 'ON'/'OFF' wire form.
    assert.deepStrictEqual(result, { power: true, mode: 'ECO', setpoint: 68, fan: 'low' });
    assert.deepStrictEqual(lastPublish().state, { power: 'ON', mode: 'ECO', setpoint: 68, fan: 'low' });
});

test('override only touches the fields given, leaving the rest of the shadow alone', () => {
    climateShadow.override({ power: true, mode: 'COOL', setpoint: 70, fan: 'auto' });
    published = [];

    const result = climateShadow.override({ setpoint: 65 });

    assert.strictEqual(sent.length, 0);
    assert.deepStrictEqual(result, { power: true, mode: 'COOL', setpoint: 65, fan: 'auto' });
});

test('override clamps an out-of-range setpoint', () => {
    const result = climateShadow.override({ setpoint: 999 });
    assert.strictEqual(result.setpoint, 80);
});

test('override ignores an invalid mode/fan without touching those fields', () => {
    climateShadow.override({ mode: 'COOL', fan: 'low' });
    const result = climateShadow.override({ mode: 'HEAT', fan: 'blast' });

    assert.strictEqual(result.mode, 'COOL');
    assert.strictEqual(result.fan, 'low');
});

// --- getState ---

test('getState returns a copy, not a live reference', () => {
    const state = climateShadow.getState();
    state.power = true;

    const stateAgain = climateShadow.getState();
    assert.strictEqual(stateAgain.power, false);
});

// --- start(): seeding ---

test('start() with no retained state seeds defaults and publishes them', () => {
    climateShadow._init({
        sendIr: fakeSendIr,
        publishState: fakePublishState,
        acEntry: AC_ENTRY,
        stepSpacingMs: SPACING_MS,
    });

    climateShadow.start();

    assert.deepStrictEqual(climateShadow.getState(), { power: false, mode: 'COOL', setpoint: 72, fan: 'auto' });
    assert.deepStrictEqual(lastPublish().state, { power: 'OFF', mode: 'COOL', setpoint: 72, fan: 'auto' });
    assert.strictEqual(sent.length, 0);
});

test('start() with no AC entry resolved defaults gracefully without throwing', () => {
    climateShadow._init({
        sendIr: fakeSendIr,
        publishState: fakePublishState,
        acEntry: null,
        stepSpacingMs: SPACING_MS,
    });

    assert.doesNotThrow(() => climateShadow.start());
    assert.deepStrictEqual(climateShadow.getState(), { power: false, mode: 'COOL', setpoint: 72, fan: 'auto' });
});
