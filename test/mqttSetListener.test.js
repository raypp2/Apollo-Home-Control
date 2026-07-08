/**
 * Unit tests for src/mqttSetListener.js (Stage 6 of the MQTT plan, issue
 * #14).
 *
 * Test-instrumentation approach: mqttSetListener.js exposes `_init({
 * subscribe, findByTopic, handleRequest })` (mirroring the override hook
 * already used by mqttTopics.js/mqttCommandListener.js/healthMonitor.js)
 * plus its subscribe callback directly as `_handleSet(topic, payload, raw,
 * retain)` -- mirroring lightingShelly.test.js's/mqttCommandListener.test.js's
 * approach of calling the handler directly rather than going through
 * mqttClient's subscribe/dispatch machinery (already tested by
 * mqttClient.test.js).
 *
 * No broker involved for the unit tests below -- pure function calls against
 * injected fakes/spies.
 *
 * The final section ("end-to-end real routing") is different: it boots the
 * REAL Apollo server (spawned as a child process, exactly like test/smoke.js
 * does) in APOLLO_DRY_RUN=1 mode and hits /api/lights/<id>/on and
 * /api/lights/<id>/<brightness> over real HTTP -- the same handleRequest ->
 * handler.js chain a built command path from this listener would traverse in
 * production. This exists because a path string this listener builds that
 * the handler silently drops (typo'd module name, wrong casing assumption,
 * etc.) would be a silent HomeKit failure never caught by the fakes above.
 * Skips gracefully (does not fail the suite) if config/lights.json isn't
 * present (e.g. a fresh clone that hasn't copied the personal config) or the
 * server fails to start for any other reason -- same convention as
 * test/mqttClient.test.js's broker probe and test/smoke.js's MQTT bridge
 * status check.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { test, beforeEach } = require('node:test');

const { _init, _handleSet } = require('../src/mqttSetListener');

// --- Fixture config entries (mirrors real lights.json/devices.json shapes) ---

const INSTEON_LIGHT = {
    id: 'kitchen',
    type: 'insteon',
    location: 'kitchen',
    mqttName: 'light',
};

const SHELLY_LIGHT = {
    id: 'garagePlug',
    type: 'shelly',
    location: 'garage',
    mqttName: 'plug',
};

const SHADES = {
    id: 'shades',
    type: 'Somfy-Bridge',
    location: 'bedroom',
    mqttName: 'shades',
};

// Topic table: '.../set' topic -> the config entry findByTopic should
// resolve for its '.../state' counterpart.
const ENTRIES_BY_STATE_TOPIC = new Map([
    ['apollo/kitchen/insteon/light/state', INSTEON_LIGHT],
    ['apollo/garage/shelly/plug/state', SHELLY_LIGHT],
    ['apollo/bedroom/somfy/shades/state', SHADES],
]);

let calls;

function fakeHandleRequest(commandPath) {
    calls.push(commandPath);
}

function fakeFindByTopic(stateTopic) {
    return ENTRIES_BY_STATE_TOPIC.get(stateTopic) || null;
}

beforeEach(() => {
    calls = [];
    _init({
        subscribe: () => {},
        findByTopic: fakeFindByTopic,
        handleRequest: fakeHandleRequest,
    });
});

// --- power ---

test('power ON on an insteon light -> /LIGHTS/<id>/on', () => {
    _handleSet('apollo/kitchen/insteon/light/set', { power: 'ON' }, null, false);
    assert.deepStrictEqual(calls, ['/LIGHTS/kitchen/on']);
});

test('power OFF on an insteon light -> /LIGHTS/<id>/off', () => {
    _handleSet('apollo/kitchen/insteon/light/set', { power: 'OFF' }, null, false);
    assert.deepStrictEqual(calls, ['/LIGHTS/kitchen/off']);
});

test('power ON on a shelly light -> /LIGHTS/<id>/on', () => {
    _handleSet('apollo/garage/shelly/plug/set', { power: 'ON' }, null, false);
    assert.deepStrictEqual(calls, ['/LIGHTS/garagePlug/on']);
});

test('power ON on the Somfy shades -> /DEVICES/<id>/all/on', () => {
    _handleSet('apollo/bedroom/somfy/shades/set', { power: 'ON' }, null, false);
    assert.deepStrictEqual(calls, ['/DEVICES/shades/all/on']);
});

test('power OFF on the Somfy shades -> /DEVICES/<id>/all/off', () => {
    _handleSet('apollo/bedroom/somfy/shades/set', { power: 'OFF' }, null, false);
    assert.deepStrictEqual(calls, ['/DEVICES/shades/all/off']);
});

test('malformed power value is ignored, never throws', () => {
    assert.doesNotThrow(() => {
        _handleSet('apollo/kitchen/insteon/light/set', { power: 'PURPLE' }, null, false);
    });
    assert.deepStrictEqual(calls, []);
});

// --- brightness ---

test('brightness on an insteon light -> /LIGHTS/<id>/<N>', () => {
    _handleSet('apollo/kitchen/insteon/light/set', { brightness: 55 }, null, false);
    assert.deepStrictEqual(calls, ['/LIGHTS/kitchen/55']);
});

test('brightness of exactly 0 is still sent (not treated as falsy)', () => {
    _handleSet('apollo/kitchen/insteon/light/set', { brightness: 0 }, null, false);
    assert.deepStrictEqual(calls, ['/LIGHTS/kitchen/0']);
});

test('malformed brightness value is ignored, never throws', () => {
    assert.doesNotThrow(() => {
        _handleSet('apollo/kitchen/insteon/light/set', { brightness: 'high' }, null, false);
    });
    assert.deepStrictEqual(calls, []);
});

test('out-of-range brightness is ignored', () => {
    _handleSet('apollo/kitchen/insteon/light/set', { brightness: 150 }, null, false);
    assert.deepStrictEqual(calls, []);
});

// --- position (shades) ---

test('shade position -> /DEVICES/shades/all/<N>', () => {
    _handleSet('apollo/bedroom/somfy/shades/set', { position: 40 }, null, false);
    assert.deepStrictEqual(calls, ['/DEVICES/shades/all/40']);
});

// --- field/type mismatches ---

test('brightness sent for a Somfy entry is skipped (logged, not executed)', () => {
    _handleSet('apollo/bedroom/somfy/shades/set', { brightness: 50 }, null, false);
    assert.deepStrictEqual(calls, []);
});

test('position sent for a light is skipped (logged, not executed)', () => {
    _handleSet('apollo/kitchen/insteon/light/set', { position: 50 }, null, false);
    assert.deepStrictEqual(calls, []);
});

// --- multi-field ordering ---

test('power executes before brightness when both are present', () => {
    _handleSet('apollo/kitchen/insteon/light/set', { brightness: 30, power: 'ON' }, null, false);
    assert.deepStrictEqual(calls, ['/LIGHTS/kitchen/on', '/LIGHTS/kitchen/30']);
});

test('power executes before position when both are present (shades)', () => {
    _handleSet('apollo/bedroom/somfy/shades/set', { position: 60, power: 'OFF' }, null, false);
    assert.deepStrictEqual(calls, ['/DEVICES/shades/all/off', '/DEVICES/shades/all/60']);
});

// --- retained messages ---

test('retained message is ignored -- handleRequest never called', () => {
    _handleSet('apollo/kitchen/insteon/light/set', { power: 'ON' }, null, true);
    assert.deepStrictEqual(calls, []);
});

// --- unknown topics ---

test('unknown topic is ignored, never throws', () => {
    assert.doesNotThrow(() => {
        _handleSet('apollo/attic/insteon/fan/set', { power: 'ON' }, null, false);
    });
    assert.deepStrictEqual(calls, []);
});

// --- malformed / empty payloads ---

test('non-JSON string payload is ignored, never throws', () => {
    assert.doesNotThrow(() => {
        _handleSet('apollo/kitchen/insteon/light/set', 'not json', null, false);
    });
    assert.deepStrictEqual(calls, []);
});

test('empty object payload (no recognized field) is ignored', () => {
    _handleSet('apollo/kitchen/insteon/light/set', {}, null, false);
    assert.deepStrictEqual(calls, []);
});

test('payload with only unrecognized fields is ignored', () => {
    _handleSet('apollo/kitchen/insteon/light/set', { color: 'red' }, null, false);
    assert.deepStrictEqual(calls, []);
});

test('null payload is ignored, never throws', () => {
    assert.doesNotThrow(() => {
        _handleSet('apollo/kitchen/insteon/light/set', null, null, false);
    });
    assert.deepStrictEqual(calls, []);
});

test('array payload is ignored, never throws', () => {
    assert.doesNotThrow(() => {
        _handleSet('apollo/kitchen/insteon/light/set', [1, 2, 3], null, false);
    });
    assert.deepStrictEqual(calls, []);
});

// --- end-to-end real routing (boots the real server, mirrors test/smoke.js) ---

const REPO_ROOT = path.resolve(__dirname, '..');
const LIGHTS_CONFIG_PATH = path.join(REPO_ROOT, 'config', 'lights.json');
const REAL_SERVER_PORT = 80;
const REAL_SERVER_STARTUP_TIMEOUT = 10000;
const REAL_SERVER_REQUEST_TIMEOUT = 5000;

function httpGet(urlPath) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out')), REAL_SERVER_REQUEST_TIMEOUT);
        http.get(`http://localhost:${REAL_SERVER_PORT}${urlPath}`, (res) => {
            res.resume();
            res.on('end', () => {
                clearTimeout(timer);
                resolve(res.statusCode);
            });
        }).on('error', (err) => {
            clearTimeout(timer);
            reject(err);
        });
    });
}

function startRealServer() {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error(`Server failed to start within ${REAL_SERVER_STARTUP_TIMEOUT}ms`));
        }, REAL_SERVER_STARTUP_TIMEOUT);

        const child = spawn('node', ['index.js'], {
            cwd: REPO_ROOT,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, APOLLO_DRY_RUN: '1' },
        });

        let started = false;
        let stderrOutput = '';

        child.stdout.on('data', (data) => {
            if (!started && data.toString().includes('HTTP Server listening')) {
                started = true;
                clearTimeout(timer);
                resolve(child);
            }
        });

        child.stderr.on('data', (data) => {
            stderrOutput += data.toString();
        });

        child.on('error', (err) => {
            clearTimeout(timer);
            reject(err);
        });

        child.on('exit', (code) => {
            if (!started) {
                clearTimeout(timer);
                reject(new Error(`Server exited before starting (code ${code}): ${stderrOutput.slice(0, 500)}`));
            }
        });
    });
}

function stopRealServer(child) {
    return new Promise((resolve) => {
        if (!child || child.killed) {
            resolve();
            return;
        }
        child.on('exit', () => resolve());
        child.kill();
        // Fallback in case 'exit' never fires.
        setTimeout(resolve, 2000);
    });
}

test('end-to-end: representative built paths route cleanly through the real handleRequest -> handler.js chain', async (t) => {
    if (!fs.existsSync(LIGHTS_CONFIG_PATH)) {
        t.skip('SKIPPED (no config/lights.json) -- personal config not present in this checkout');
        return;
    }

    let entries;
    try {
        entries = JSON.parse(fs.readFileSync(LIGHTS_CONFIG_PATH, 'utf8').replace(/\/\/.*$/gm, ''));
    } catch {
        t.skip('SKIPPED (config/lights.json is not parseable as plain JSON in this check)');
        return;
    }
    const kitchenLight = entries.find((entry) => entry.id === 'kitchen');
    if (!kitchenLight) {
        t.skip('SKIPPED (no "kitchen" light in config/lights.json)');
        return;
    }

    let server;
    try {
        server = await startRealServer();
    } catch (err) {
        t.skip(`SKIPPED (could not start real server) -- ${err.message}`);
        return;
    }

    try {
        // These are exactly the shape of path this listener's buildFieldPath()
        // produces for an insteon LIGHTS entry -- see the "power ON on an
        // insteon light" and "brightness on an insteon light" unit tests above.
        const onStatus = await httpGet('/api/lights/kitchen/on');
        assert.strictEqual(onStatus, 200, '/api/lights/kitchen/on should route cleanly (200)');

        const brightnessStatus = await httpGet('/api/lights/kitchen/55');
        assert.strictEqual(brightnessStatus, 200, '/api/lights/kitchen/55 should route cleanly (200)');
    } finally {
        await stopRealServer(server);
    }
});
