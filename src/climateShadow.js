/**
 * Apollo Home Control Bridge - Climate Shadow State
 * @module climateShadow.js
 *
 * @description  Dashboard redesign, increment 4 (documentation/dashboard-redesign-plan.md
 *               §4.4). `livingRoomAC` (config/devices.json, type `iTach_ir`) is a
 *               one-way GlobalCache IR blaster: every command is a relative IR
 *               blast (`temp_increase`, `fan_speed_increase`, ...) with zero
 *               acknowledgement from the physical unit. There is no way to ask
 *               the AC what it's actually set to.
 *
 *               So Apollo remembers instead. This module holds an in-memory
 *               "shadow" of what it believes the unit is set to --
 *               {power, mode, setpoint, fan} -- and translates the dashboard's
 *               absolute intents ("set to 74", "fan: high") into the relative
 *               IR sends the hardware actually understands. Ray rarely touches
 *               the physical remote, so the shadow is treated as authoritative;
 *               override() is the manual recalibration path for the rare case
 *               it drifts ("the unit is actually at 68 / ECO / low"), and it
 *               updates the shadow WITHOUT sending any IR.
 *
 *               Published (retained, QoS 1) to the AC's existing canonical
 *               state topic via mqttTopics.publishState -- for `livingRoomAC`
 *               that's apollo/home/itach/livingRoomAC/state:
 *                 {power, mode, setpoint, fan, reachable, timestamp, source}
 *               (reachable/timestamp/source are stamped by publishState itself).
 *
 *               Setpoint and fan changes are optimistic: the shadow field (and
 *               the retained publish) update to the target immediately, before
 *               the IR steps needed to get there have actually gone out --
 *               there's no readback to wait for anyway, and the whole point of
 *               the shadow is that Apollo's belief IS the state.
 *
 *               Multi-step translations (setpoint deltas, fan ladder steps) are
 *               spaced ~600ms apart via chained setTimeout calls -- the IR
 *               blaster / AC can't reliably absorb a rapid burst of button
 *               presses. The spacing is injectable (see _init) so tests don't
 *               wait on real timers.
 *
 *               TESTING NOTE: mirrors sceneShadow.js's / healthMonitor.js's
 *               shape. Real deps (iTachControllers.send_ir_command,
 *               mqttTopics.publishState, the `devices` config, mqttTopics'
 *               retained-state cache) are pulled in lazily via ensureInit(),
 *               so merely requiring this file never sends IR or boots
 *               index.js. Tests call `_init({ sendIr, publishState, acEntry,
 *               stepSpacingMs })` with fixture/spy functions and a tiny
 *               stepSpacingMs first, then drive the module directly via
 *               setPower()/setMode()/setSetpoint()/setFan()/override().
 */

'use strict';

const AC_DEVICE_ID = 'livingRoomAC';

const DEFAULT_STATE = { power: false, mode: 'COOL', setpoint: 72, fan: 'auto' };

// Ordinal ladder for the addressable (non-auto) fan speeds. 'auto' is
// directly addressable (fan_auto) and sits outside this ladder -- see
// fanCommandSequence()'s doc comment for how the two are reconciled.
const FAN_LADDER = ['low', 'med', 'high'];
const VALID_FAN_VALUES = new Set(['auto', ...FAN_LADDER]);

let doSendIr;
let doPublishState;
let doLastState = () => null; // no-op default; real wiring set in ensureInit()
let acEntry = null;
let STEP_SPACING_MS = 600;
// How long start() waits for the broker's retained replay to land in
// mqttTopics' cache before seeding + republishing (see start()'s TIMING
// note). Tests set 0 via _init for synchronous behavior.
let START_SETTLE_MS = 3000;
let initialized = false;

// True once any publish() has run this process (commands, overrides, or the
// deferred startup seed itself) -- gates the deferred seed so it never
// clobbers state a real command established first.
let touchedSinceStart = false;

// Current shadow. Seeded to DEFAULT_STATE until start() (or a test) seeds it
// for real -- so getState() is always well-formed even before start() runs.
let state = { ...DEFAULT_STATE };

// Local debug-id counter for IR-send logging only; independent of index.js's
// global logging.operation_num (this module never touches that shared
// counter, keeping its DI clean per the module doc comment above).
let debugCounter = 0;

// Outstanding setTimeout handles from in-progress spaced-command sequences,
// tracked so _resetForTesting() can cancel them and stop tests from leaking
// timers into each other (mirrors sceneShadow.js's learningBySceneId map).
const pendingTimers = new Set();

/**
 * Lazily wires this module to the real iTachControllers/mqttTopics/config the
 * first time it's actually needed (start()/setPower()/etc). See the module
 * doc comment for why this is lazy rather than a top-level require.
 */
function ensureInit() {
    if (initialized) {
        return;
    }
    const iTachControllers = require('./iTachControllers');
    const mqttTopics = require('./mqttTopics');
    const index = require('../index');
    doSendIr = iTachControllers.send_ir_command;
    doPublishState = mqttTopics.publishState;
    doLastState = mqttTopics.lastState;
    acEntry = (index.devices || []).find((d) => d && d.id === AC_DEVICE_ID) || null;
    initialized = true;
}

/**
 * Test-only (and otherwise unused in production) override hook. See the
 * module doc comment above for why this exists.
 * @param {object} deps
 * @param {function} deps.sendIr - (address, irCommandString, debugId) => void
 * @param {function} deps.publishState - (entry, state, source) => object
 * @param {object} deps.acEntry - the livingRoomAC config entry (address + commands)
 * @param {number} [deps.stepSpacingMs] - delay between chained IR sends; defaults to 600
 */
function _init({ sendIr, publishState, lastState, acEntry: acEntryOverride, stepSpacingMs, startSettleMs } = {}) {
    doSendIr = sendIr;
    doPublishState = publishState;
    doLastState = lastState || (() => null);
    acEntry = acEntryOverride || null;
    STEP_SPACING_MS = Number.isFinite(stepSpacingMs) ? stepSpacingMs : 600;
    START_SETTLE_MS = Number.isFinite(startSettleMs) ? startSettleMs : 0; // tests default to synchronous
    initialized = true;
}

/**
 * Clamps a setpoint to the AC's addressable range (60-80 inclusive). Falls
 * back to the current shadow setpoint if `value` isn't a usable number, so a
 * malformed call never corrupts the shadow.
 * @param {*} value
 * @returns {number}
 */
function clampSetpoint(value) {
    const n = parseInt(value, 10);
    if (!Number.isFinite(n)) {
        return state.setpoint;
    }
    return Math.min(80, Math.max(60, n));
}

/**
 * Publishes the current shadow, retained QoS 1, to the AC's canonical state
 * topic. No-ops (with a log line) if the AC entry couldn't be resolved --
 * defensive only; in practice `livingRoomAC` is always in devices.json.
 */
function publish() {
    if (!acEntry) {
        console.log('climateShadow: no AC device entry resolved -- skipping publish');
        return;
    }
    touchedSinceStart = true;
    // Wire/dashboard convention: every other Apollo device publishes
    // power as the string 'ON'/'OFF' (the dashboard checks
    // `live.power === 'ON'`) -- convert at this publish boundary only;
    // the internal shadow (`state.power`) stays a plain boolean.
    doPublishState(acEntry, { ...state, power: powerToWire(state.power) }, 'command');
}

/**
 * Converts the internal boolean shadow power to the 'ON'/'OFF' wire
 * convention used by every other Apollo device's published state.
 * @param {boolean} power
 * @returns {'ON'|'OFF'}
 */
function powerToWire(power) {
    return power ? 'ON' : 'OFF';
}

/**
 * Inverse of powerToWire() -- reads a retained payload's power field back
 * into the internal boolean shadow. Tolerant of the 'ON'/'OFF' wire strings
 * (the normal case) as well as a legacy raw boolean that may still be sitting
 * in a retained message from before this conversion existed.
 * @param {*} value
 * @returns {boolean}
 */
function powerFromWire(value) {
    if (typeof value === 'string') {
        return value === 'ON';
    }
    return Boolean(value);
}

function nextDebugId() {
    debugCounter += 1;
    return debugCounter;
}

/**
 * Looks up `commandName` in the AC entry's `commands` map and fires it as an
 * IR send. No-ops (with a log line) if the AC entry or the specific command
 * key is missing, rather than throwing -- a config gap shouldn't crash the
 * caller.
 * @param {string} commandName - e.g. 'temp_increase', 'fan_auto', 'on'
 * @param {number} debugId
 */
function sendCommandByName(commandName, debugId) {
    if (!acEntry) {
        console.log('%d - climateShadow: no AC device entry -- skipping IR send for %s', debugId, commandName);
        return;
    }
    const irString = acEntry.commands && acEntry.commands[commandName];
    if (!irString) {
        console.log('%d - climateShadow: no command configured for %s -- skipping IR send', debugId, commandName);
        return;
    }
    doSendIr(acEntry.address, irString, debugId);
}

/**
 * Fires a list of command names as spaced IR sends -- the first immediately,
 * each subsequent one STEP_SPACING_MS after the previous actually fired
 * (chained setTimeout, not a fixed schedule, so the spacing survives whatever
 * the event loop does before the first timer runs). The shadow's in-memory
 * field and its retained publish have already been updated by the caller
 * before this is invoked (optimistic -- see module doc comment), so this is
 * purely "make the physical unit catch up."
 * @param {string[]} commandNames
 */
function fireSpacedCommands(commandNames) {
    const queue = commandNames.slice();
    scheduleNext(queue, true);
}

function scheduleNext(queue, isFirst) {
    if (queue.length === 0) {
        return;
    }
    const delay = isFirst ? 0 : STEP_SPACING_MS;
    const timer = setTimeout(() => {
        pendingTimers.delete(timer);
        const commandName = queue.shift();
        sendCommandByName(commandName, nextDebugId());
        scheduleNext(queue, false);
    }, delay);
    if (typeof timer.unref === 'function') {
        timer.unref();
    }
    pendingTimers.add(timer);
}

/**
 * Turns the AC on/off. Sends the `on`/`off` IR command, updates the shadow,
 * and publishes.
 * @param {boolean} on
 * @returns {object} the new shadow state (see getState())
 */
function setPower(on) {
    ensureInit();
    const target = Boolean(on);
    sendCommandByName(target ? 'on' : 'off', nextDebugId());
    state.power = target;
    publish();
    return getState();
}

/**
 * Sets the AC mode. Only COOL and ECO exist on this unit (no Heat/Fan/Dry/
 * Auto -- see plan §4.4) -- anything else is logged and ignored, shadow
 * unchanged.
 * @param {'COOL'|'ECO'} mode
 * @returns {object} the new shadow state
 */
function setMode(mode) {
    ensureInit();
    const target = String(mode).toUpperCase();
    if (target !== 'COOL' && target !== 'ECO') {
        console.log('climateShadow: ignoring unknown mode %s (only COOL/ECO exist)', mode);
        return getState();
    }
    sendCommandByName(target, nextDebugId());
    state.mode = target;
    publish();
    return getState();
}

/**
 * Sets the AC's target setpoint (60-80, clamped). Translates the absolute
 * target into a run of `temp_increase`/`temp_decrease` IR sends equal to the
 * distance from the current shadow setpoint, spaced ~600ms apart (see
 * fireSpacedCommands()). The shadow field and its retained publish update to
 * the target IMMEDIATELY -- optimistic, before the IR steps have actually
 * gone out -- per the module doc comment.
 * @param {number} target
 * @returns {object} the new shadow state (already reflects `target`)
 */
function setSetpoint(target) {
    ensureInit();
    const clamped = clampSetpoint(target);
    const steps = clamped - state.setpoint;

    state.setpoint = clamped;
    publish();

    if (steps !== 0) {
        const commandName = steps > 0 ? 'temp_increase' : 'temp_decrease';
        fireSpacedCommands(new Array(Math.abs(steps)).fill(commandName));
    }

    return getState();
}

/**
 * Builds the IR command sequence needed to move the fan shadow from `current`
 * to `target`.
 *
 * - Same value: no-op, no commands.
 * - Any -> 'auto': directly addressable, single `fan_auto` send.
 * - 'auto' -> low/med/high: the physical ordinal position coming out of auto
 *   is unknown (no readback) -- this is a documented simplification per plan
 *   §4.4, not a guarantee. Anchor with one `fan_auto` send, then step UP from
 *   the ladder's bottom rung (low, ordinal 0) with `fan_speed_increase` until
 *   reaching the target's ordinal. If this lands wrong, override() corrects
 *   the shadow without sending IR.
 * - low/med/high -> low/med/high: step the ordinal distance with
 *   `fan_speed_increase`/`fan_speed_decrease` as appropriate.
 * @param {'auto'|'low'|'med'|'high'} current
 * @param {'auto'|'low'|'med'|'high'} target
 * @returns {string[]}
 */
function fanCommandSequence(current, target) {
    if (current === target) {
        return [];
    }
    if (target === 'auto') {
        return ['fan_auto'];
    }
    const targetIdx = FAN_LADDER.indexOf(target);
    if (current === 'auto') {
        return ['fan_auto', ...new Array(targetIdx + 1).fill('fan_speed_increase')];
    }
    const fromIdx = FAN_LADDER.indexOf(current);
    const diff = targetIdx - fromIdx;
    const commandName = diff > 0 ? 'fan_speed_increase' : 'fan_speed_decrease';
    return new Array(Math.abs(diff)).fill(commandName);
}

/**
 * Sets the AC's fan speed ('auto'|'low'|'med'|'high'). See
 * fanCommandSequence() for the stepping logic. Optimistic, same as
 * setSetpoint(): the shadow field/publish update to the target immediately,
 * the (possibly multi-step) IR sequence follows spaced via
 * fireSpacedCommands().
 * @param {'auto'|'low'|'med'|'high'} fan
 * @returns {object} the new shadow state (already reflects `fan`)
 */
function setFan(fan) {
    ensureInit();
    const target = String(fan).toLowerCase();
    if (!VALID_FAN_VALUES.has(target)) {
        console.log('climateShadow: ignoring unknown fan speed %s', fan);
        return getState();
    }

    const commands = fanCommandSequence(state.fan, target);
    state.fan = target;
    publish();

    if (commands.length > 0) {
        fireSpacedCommands(commands);
    }

    return getState();
}

/**
 * Manual drift-correction / recalibration (Ray's ask, plan §4.4): overwrites
 * any subset of the shadow fields with the given values WITHOUT sending any
 * IR -- "the unit is actually at 68 / ECO / low." Then publishes. Unknown or
 * invalid field values are ignored individually rather than rejecting the
 * whole call.
 * @param {object} partial
 * @param {boolean} [partial.power]
 * @param {'COOL'|'ECO'} [partial.mode]
 * @param {number} [partial.setpoint]
 * @param {'auto'|'low'|'med'|'high'} [partial.fan]
 * @returns {object} the new shadow state
 */
function override(partial) {
    ensureInit();
    if (!partial || typeof partial !== 'object') {
        return getState();
    }

    if (partial.power !== undefined) {
        state.power = Boolean(partial.power);
    }
    if (partial.mode !== undefined) {
        const mode = String(partial.mode).toUpperCase();
        if (mode === 'COOL' || mode === 'ECO') {
            state.mode = mode;
        } else {
            console.log('climateShadow: override ignoring unknown mode %s', partial.mode);
        }
    }
    if (partial.setpoint !== undefined) {
        state.setpoint = clampSetpoint(partial.setpoint);
    }
    if (partial.fan !== undefined) {
        const fan = String(partial.fan).toLowerCase();
        if (VALID_FAN_VALUES.has(fan)) {
            state.fan = fan;
        } else {
            console.log('climateShadow: override ignoring unknown fan speed %s', partial.fan);
        }
    }

    publish();
    return getState();
}

/**
 * Returns a shallow copy of the current shadow state.
 * @returns {{power: boolean, mode: string, setpoint: number, fan: string}}
 */
function getState() {
    return { ...state };
}

/**
 * Seeds the shadow at startup: if the AC's retained MQTT state survived a
 * restart (mqttTopics' merge cache, seeded from the broker's retained replay
 * via healthMonitor -> mqttTopics.seedFromRetained()), adopt it; otherwise
 * fall back to DEFAULT_STATE. Then republishes so the retained topic
 * reflects what this process now believes.
 *
 * TIMING: the retained replay arrives asynchronously, some moments AFTER
 * index.js calls start() -- reading lastState() synchronously here would
 * always see an empty cache on a real restart, publish defaults, and (since
 * publishState fills the cache slot) cause the actual retained replay to be
 * discarded when it lands. That silently reset the AC's assumed state
 * (power OFF) on every deploy. So the seed + publish are DEFERRED by
 * START_SETTLE_MS; if a real command/override arrives first (publish() sets
 * touchedSinceStart), the deferred seed becomes a no-op -- the command
 * already established fresher state. Never sends IR -- read + publish only,
 * so this is safe in dry-run and with the broker down, same as
 * sceneShadow.start()/healthMonitor.start().
 */
function seedAndPublish() {
    if (touchedSinceStart) {
        return; // a command beat the settle window; its state is fresher
    }

    const retained = doLastState(acEntry);
    if (retained && typeof retained === 'object') {
        state = {
            power: retained.power !== undefined ? powerFromWire(retained.power) : DEFAULT_STATE.power,
            mode: retained.mode === 'ECO' || retained.mode === 'COOL' ? retained.mode : DEFAULT_STATE.mode,
            setpoint: clampSetpoint(
                retained.setpoint !== undefined ? retained.setpoint : DEFAULT_STATE.setpoint
            ),
            fan: VALID_FAN_VALUES.has(retained.fan) ? retained.fan : DEFAULT_STATE.fan,
        };
    } else {
        state = { ...DEFAULT_STATE };
    }

    publish();
}

function start() {
    ensureInit();

    if (!acEntry) {
        console.log('climateShadow: livingRoomAC not found in devices config -- shadow running with defaults');
        state = { ...DEFAULT_STATE };
        return;
    }

    if (START_SETTLE_MS <= 0) {
        // Test path: deterministic synchronous seeding.
        seedAndPublish();
        return;
    }

    const timer = setTimeout(() => {
        pendingTimers.delete(timer);
        seedAndPublish();
    }, START_SETTLE_MS);
    pendingTimers.add(timer);
}

/**
 * Test-only hook: clears the shadow back to defaults, cancels any pending
 * spaced-command timers, and resets the debug-id counter. Never called from
 * production code.
 */
function _resetForTesting() {
    for (const timer of pendingTimers) {
        clearTimeout(timer);
    }
    pendingTimers.clear();
    state = { ...DEFAULT_STATE };
    debugCounter = 0;
    touchedSinceStart = false;
}

module.exports = {
    start,
    setPower,
    setMode,
    setSetpoint,
    setFan,
    override,
    getState,
    _init,
    _resetForTesting,
};
