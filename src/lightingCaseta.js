/**
 * Apollo Home Control Bridge - Lutron Caseta Module
 * @module lightingCaseta.js
 *
 * @description  Drives a Lutron Caseta Smart Bridge over LEAP (TLS client
 *               cert, port 8081) using the `lutron-leap` library.
 *
 *               - ONE persistent LeapClient. Connects at startup, reconnects
 *                 with capped exponential backoff (1s -> 30s) on 'disconnected'
 *                 or a failed connect, and publishes reachability on the
 *                 retained `apollo/bridge/caseta/status` ("online"/"offline").
 *               - State: on connect, reads every configured caseta light's
 *                 `<zone>/status`, then SubscribeRequests `/zone/status` for
 *                 pushed updates. Publishes {power, brightness} via
 *                 mqttTopics.publishState(..., 'event').
 *               - Commands: caseta_command(op, "/zone/N", cmd) -> LEAP
 *                 CreateRequest `<zone>/commandprocessor` GoToLevel. ON restores
 *                 the last non-zero level (100 if unknown). Dropped (not queued)
 *                 while disconnected.
 *               - Pico remotes: subscribes to `<button>/status/event` for every
 *                 button in config/caseta.json, publishes each event (non-retained)
 *                 to `apollo/home/caseta/<picoId>/button` and, if the config maps
 *                 "<buttonName>.<EventType>" to an Apollo path, runs it through
 *                 handleRequest (same mechanism as Insteon keypad presses).
 *
 *               Pairing credentials live in data/caseta.json
 *               ({host,key,cert,ca,pairedAt}; override path with env
 *               CASETA_PAIRING_FILE). If missing, the driver logs once and stays
 *               disabled. Never logs key material.
 *
 *               TESTING NOTE: dependencies are resolved lazily; tests call
 *               `_init({ lights, pico, publish, publishState, publishUnreachable,
 *               createClient, readPairing, handleRequest, setTimer, clearTimer })`
 *               with fakes -- no network, no index.js boot.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const BRIDGE_STATUS_TOPIC = 'apollo/bridge/caseta/status';
const LEAP_PORT = 8081;
const BACKOFF_INITIAL_MS = 1000;
const BACKOFF_MAX_MS = 30000;
const PING_INTERVAL_MS = 30000;

const PAIRING_FILE = process.env.CASETA_PAIRING_FILE
    || path.join(__dirname, '..', 'data', 'caseta.json');

let deps = null;          // set by ensureInit()/_init()
let started = false;
let disabled = false;
let client = null;
let connected = false;
let bridgeStatus = null;  // last published status, to avoid republishing
let reconnectTimer = null;
let pingTimer = null;
let backoffMs = BACKOFF_INITIAL_MS;
let generation = 0;       // bumps per connection attempt; stale callbacks are ignored
let pairing = null;
let handleRequestFn = null;
const lastLevel = new Map(); // zone href -> last non-zero level
let loggedMissing = false;

function defaultReadPairing() {
    try {
        return JSON.parse(fs.readFileSync(PAIRING_FILE, 'utf8'));
    } catch (e) {
        return null;
    }
}

function defaultCreateClient(p) {
    const { LeapClient } = require('lutron-leap');
    return new LeapClient(p.host, LEAP_PORT, p.ca, p.key, p.cert);
}

function defaultPicoConfig() {
    try {
        const JSON5 = require('json5');
        return JSON5.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'caseta.json'), 'utf8'));
    } catch (e) {
        return [];
    }
}

function ensureInit() {
    if (deps) {
        return;
    }
    const mqttClient = require('./mqttClient');
    const mqttTopics = require('./mqttTopics');
    deps = {
        get lights() { return require('../index').lights || []; },
        pico: defaultPicoConfig(),
        publish: mqttClient.publish,
        publishState: mqttTopics.publishState,
        publishUnreachable: mqttTopics.publishUnreachable,
        createClient: defaultCreateClient,
        readPairing: defaultReadPairing,
        setTimer: setTimeout,
        clearTimer: clearTimeout,
        nextOp: () => ++require('../index').logging.operation_num,
    };
}

/**
 * Test-only override hook (see module doc comment).
 */
function _init(overrides) {
    deps = {
        lights: [],
        pico: [],
        publish: () => {},
        publishState: () => {},
        publishUnreachable: () => {},
        createClient: () => { throw new Error('no client'); },
        readPairing: () => null,
        setTimer: setTimeout,
        clearTimer: clearTimeout,
        ...overrides,
    };
    handleRequestFn = overrides.handleRequest || null;
}

/** Test-only: clear all module state. */
function _reset() {
    if (deps && reconnectTimer) { deps.clearTimer(reconnectTimer); }
    if (deps && pingTimer) { deps.clearTimer(pingTimer); }
    deps = null;
    started = false;
    disabled = false;
    client = null;
    connected = false;
    bridgeStatus = null;
    reconnectTimer = null;
    pingTimer = null;
    backoffMs = BACKOFF_INITIAL_MS;
    generation = 0;
    pairing = null;
    handleRequestFn = null;
    lastLevel.clear();
    loggedMissing = false;
}

function _getState() {
    return { connected, disabled, started, backoffMs, bridgeStatus, reconnectPending: reconnectTimer !== null };
}

function casetaLights() {
    return deps.lights.filter((l) => l && l.type === 'caseta');
}

function findLightByZone(href) {
    return casetaLights().find((l) => l.address === href) || null;
}

function publishBridgeStatus(status) {
    if (bridgeStatus === status) {
        return;
    }
    bridgeStatus = status;
    deps.publish(BRIDGE_STATUS_TOPIC, status, { qos: 1, retain: true });
}

// ################# STATE #################

/**
 * Handles one ZoneStatus body object: publishes canonical state and syncs
 * the in-memory lights entry.
 */
function _handleZoneStatus(zs, source) {
    if (!zs || !zs.Zone || !zs.Zone.href) {
        return;
    }
    const entry = findLightByZone(zs.Zone.href);
    if (!entry) {
        return;
    }
    if (zs.Availability === 'Unavailable') {
        deps.publishUnreachable(entry);
        return;
    }
    let level = zs.Level;
    if (typeof level !== 'number') {
        if (zs.SwitchedLevel === 'On') { level = 100; }
        else if (zs.SwitchedLevel === 'Off') { level = 0; }
        else { return; }
    }
    level = Math.max(0, Math.min(100, Math.round(level)));
    if (level > 0) {
        lastLevel.set(zs.Zone.href, level);
    }
    deps.publishState(entry, { power: level > 0 ? 'ON' : 'OFF', brightness: level }, source || 'event');
    entry.checked = level > 0;
    entry.status = level;
}

/**
 * Callback for zone status responses/pushes. Accepts both a single
 * `ZoneStatus` and the initial `ZoneStatuses` array from the subscribe reply.
 */
function _onZoneResponse(resp, source) {
    try {
        const body = resp && resp.Body;
        if (!body) {
            return;
        }
        if (body.ZoneStatus) {
            _handleZoneStatus(body.ZoneStatus, source);
        }
        if (Array.isArray(body.ZoneStatuses)) {
            body.ZoneStatuses.forEach((zs) => _handleZoneStatus(zs, source));
        }
    } catch (err) {
        console.log('Caseta: zone status handling error: %s', err.message);
    }
}

// ################# PICO #################

let picoOpSeq = 0;

function _nextOp() {
    return deps.nextOp ? deps.nextOp() : ++picoOpSeq;
}

/**
 * Handles one Pico button event. Publishes to MQTT (non-retained) and runs
 * any mapped action.
 */
function _handleButtonEvent(pico, button, resp) {
    try {
        const body = resp && resp.Body;
        const ev = body && body.ButtonStatus && body.ButtonStatus.ButtonEvent;
        if (!ev || !ev.EventType) {
            return;
        }
        const eventType = ev.EventType;
        const op = _nextOp();
        console.log('%d - Caseta Pico %s button %s: %s', op, pico.id, button.name, eventType);
        deps.publish(`apollo/home/caseta/${pico.id}/button`, {
            button: button.name,
            event: eventType,
            timestamp: Math.floor(Date.now() / 1000),
        }, { qos: 0, retain: false });

        const actions = pico.actions || {};
        const action = actions[`${button.name}.${eventType}`];
        if (action && handleRequestFn) {
            const p = String(action).startsWith('/') ? action : '/' + action;
            console.log('%d - Caseta Pico running %s', op, p);
            handleRequestFn(p);
        }
    } catch (err) {
        console.log('Caseta: button event error: %s', err.message);
    }
}

// ################# CONNECTION #################

function scheduleReconnect() {
    if (reconnectTimer || disabled) {
        return;
    }
    const delay = backoffMs;
    backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
    console.log('Caseta: reconnecting in %dms', delay);
    reconnectTimer = deps.setTimer(() => {
        reconnectTimer = null;
        connect();
    }, delay);
    if (reconnectTimer && typeof reconnectTimer.unref === 'function') {
        reconnectTimer.unref();
    }
}

function teardownClient() {
    if (pingTimer) {
        deps.clearTimer(pingTimer);
        pingTimer = null;
    }
    const old = client;
    client = null;
    connected = false;
    if (old) {
        try {
            if (typeof old.drain === 'function') { old.drain(); } else { old.close(); }
        } catch (e) { /* ignore */ }
    }
}

function handleDisconnect(gen, reason) {
    if (gen !== generation) {
        return; // stale client
    }
    console.log('Caseta: disconnected (%s)', reason);
    const wasOnline = bridgeStatus === 'online';
    teardownClient();
    publishBridgeStatus('offline');
    if (wasOnline) {
        casetaLights().forEach((l) => {
            try { deps.publishUnreachable(l); } catch (e) { /* ignore */ }
        });
    }
    scheduleReconnect();
}

function startPing(gen) {
    const tick = () => {
        if (gen !== generation || !client) {
            return;
        }
        Promise.resolve()
            .then(() => client.request('ReadRequest', '/server/1/status/ping'))
            .then(() => {
                if (gen === generation) {
                    pingTimer = deps.setTimer(tick, PING_INTERVAL_MS);
                    if (pingTimer && typeof pingTimer.unref === 'function') { pingTimer.unref(); }
                }
            })
            .catch((err) => handleDisconnect(gen, 'ping failed: ' + err.message));
    };
    pingTimer = deps.setTimer(tick, PING_INTERVAL_MS);
    if (pingTimer && typeof pingTimer.unref === 'function') { pingTimer.unref(); }
}

/**
 * Opens (or re-opens) the LEAP connection, reads initial zone state and sets
 * up the zone + Pico subscriptions. Never throws; failures schedule a retry.
 */
async function connect() {
    if (disabled || client) {
        return;
    }
    const gen = ++generation;
    let c;
    try {
        c = deps.createClient(pairing);
        client = c;
        c.on('disconnected', () => handleDisconnect(gen, 'socket closed'));
        c.on('unsolicited', (resp) => _onZoneResponse(resp, 'event'));
        await c.connect();
        if (gen !== generation) { return; }

        // Initial state read for every configured light (poll-sourced).
        for (const light of casetaLights()) {
            try {
                const resp = await c.request('ReadRequest', `${light.address}/status`);
                _onZoneResponse(resp, 'poll');
            } catch (err) {
                console.log('Caseta: initial read of %s failed: %s', light.address, err.message);
            }
        }

        // Pushed zone updates. The subscribe reply itself carries current statuses.
        const sub = await c.subscribe('/zone/status', (resp) => _onZoneResponse(resp, 'event'));
        if (sub && sub.response) { _onZoneResponse(sub.response, 'poll'); }

        // Pico buttons.
        for (const pico of deps.pico || []) {
            for (const button of pico.buttons || []) {
                const b = { ...button, name: button.name };
                await c.subscribe(`${button.id}/status/event`, (resp) => _handleButtonEvent(pico, b, resp));
            }
        }

        if (gen !== generation) { return; }
        connected = true;
        backoffMs = BACKOFF_INITIAL_MS;
        publishBridgeStatus('online');
        console.log('Caseta: connected (%d light(s), %d pico(s))', casetaLights().length, (deps.pico || []).length);
        startPing(gen);
    } catch (err) {
        console.log('Caseta: connect failed: %s', err.message);
        if (gen === generation) {
            teardownClient();
            publishBridgeStatus('offline');
            scheduleReconnect();
        }
    }
}

/**
 * Starts the Caseta driver. Safe to call once at startup. No-ops in dry run
 * and (logging once) when the pairing file is missing.
 * @param {function} [handleRequest] - for Pico-mapped actions
 */
function startCasetaListener(handleRequest) {
    if (started) {
        return;
    }
    started = true;
    if (process.env.APOLLO_DRY_RUN === '1') {
        console.log('Caseta: APOLLO_DRY_RUN=1, not connecting');
        return;
    }
    ensureInit();
    if (handleRequest) {
        handleRequestFn = handleRequest;
    }
    pairing = deps.readPairing();
    if (!pairing || !pairing.host || !pairing.key || !pairing.cert || !pairing.ca) {
        disabled = true;
        if (!loggedMissing) {
            loggedMissing = true;
            console.log('Caseta: no usable pairing file (%s) -- driver disabled', PAIRING_FILE);
        }
        return;
    }
    connect();
}

// ################# COMMANDS #################

/**
 * @param {number} operation_num
 * @param {string} address - LEAP zone href, e.g. "/zone/1"
 * @param {string|number} lighting_command - ON | OFF | 0..100
 * @returns {Promise<void>}
 */
async function caseta_command(operation_num, address, lighting_command) {
    ensureInit();
    const cmd = String(lighting_command).toUpperCase();

    let level;
    if (cmd === 'ON') {
        level = lastLevel.get(address) || 100;
    } else if (cmd === 'OFF') {
        level = 0;
    } else if (lighting_command !== '' && !isNaN(lighting_command)) {
        level = Math.max(0, Math.min(100, Math.round(Number(lighting_command))));
    } else {
        console.log('%d - ERR: Caseta command not recognized: %s', operation_num, lighting_command);
        return;
    }

    if (process.env.APOLLO_DRY_RUN === '1') {
        console.log('%d - DRY RUN would send Caseta GoToLevel %d to %s', operation_num, level, address);
        return;
    }

    if (!connected || !client) {
        console.log('%d - Caseta not connected, dropping command %s for %s', operation_num, lighting_command, address);
        return;
    }

    try {
        const resp = await client.request('CreateRequest', `${address}/commandprocessor`, {
            Command: {
                CommandType: 'GoToLevel',
                Parameter: [{ Type: 'Level', Value: level }],
            },
        });
        const status = resp && resp.Header && resp.Header.StatusCode;
        if (status && typeof status.isSuccessful === 'function' && !status.isSuccessful()) {
            console.log('%d - Caseta command rejected: %s', operation_num, status.message);
            return;
        }
        console.log('%d - Sent Caseta GoToLevel %d to %s', operation_num, level, address);
        if (level > 0) {
            lastLevel.set(address, level);
        }
        const entry = findLightByZone(address);
        if (entry) {
            deps.publishState(entry, { power: level > 0 ? 'ON' : 'OFF', brightness: level }, 'command');
            entry.checked = level > 0;
            entry.status = level;
        }
    } catch (err) {
        console.log('%d - Caseta command error: %s', operation_num, err.message);
    }
}

module.exports = {
    caseta_command,
    startCasetaListener,
    BRIDGE_STATUS_TOPIC,
    _init,
    _reset,
    _getState,
    _handleZoneStatus,
    _onZoneResponse,
    _handleButtonEvent,
    _connect: connect,
};
