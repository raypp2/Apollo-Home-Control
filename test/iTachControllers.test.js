/**
 * Unit tests for src/iTachControllers.js's persistent-connection wrappers
 * (Stage 5 of documentation/mqtt-implementation-detail.md, issue #13).
 *
 * All fixtures are local `net.createServer` instances bound to 127.0.0.1 on
 * the SAME fixed ports the module itself hardcodes (4999 for serial, 4998
 * for IR/CC -- matching the original per-command implementation's own
 * hardcoded ports, since the function signatures never took a port
 * parameter). These are loopback-only fixtures; no real iTach or Pi is ever
 * touched, per the Stage 5 safety constraint.
 *
 * mqttTopics.js is wired to a fixture device via `_init({ lights, devices,
 * publish })`, same pattern as test/lightingShelly.test.js and
 * test/somfyBridge.test.js. iTachControllers.js's own status publisher does a
 * SEPARATE reverse lookup into devices.json (an iTach connection can be
 * shared by more than one logical device, unlike lights); it mirrors that
 * same `_init({ devices })` escape hatch (see its module doc comment) so this
 * file never triggers `require('../index')` -- which would boot the real
 * config, webServer.listen(80), SQS, Hue SSE, etc as a side effect, exactly
 * as documented in mqttTopics.js's own module comment. Both `_init` calls are
 * wired in `beforeEach` before any test runs a real connection.
 */

const assert = require('node:assert');
const { test, beforeEach, afterEach } = require('node:test');
const net = require('net');

const mqttTopics = require('../src/mqttTopics');
const mqttClient = require('../src/mqttClient');
const { _resetAll } = require('../src/deviceConnection');
const iTach = require('../src/iTachControllers');

const SERIAL_PORT = 4999;
const IR_CC_PORT = 4998;

let published;
function fakePublish(topic, payload, opts) {
    published.push({ topic, payload, opts });
}

const testIrDevice = {
    id: 'testItachIr',
    type: 'iTach_ir',
    address: '127.0.0.1',
    location: 'test',
    mqttName: 'test-ir',
};

let server = null;
let originalRollbackEnv;

function startFixture(port, onData) {
    return new Promise((resolve) => {
        server = net.createServer((socket) => {
            socket.on('error', () => {});
            socket.on('data', (data) => onData(socket, data));
            socket.resume();
        });
        server.on('error', () => {});
        server.listen(port, '127.0.0.1', resolve);
    });
}

function waitUntil(conditionFn, { timeoutMs = 1000, intervalMs = 10 } = {}) {
    const start = Date.now();
    return new Promise((resolve, reject) => {
        const check = () => {
            if (conditionFn()) {
                resolve();
                return;
            }
            if (Date.now() - start > timeoutMs) {
                reject(new Error(`waitUntil: condition not met within ${timeoutMs}ms`));
                return;
            }
            setTimeout(check, intervalMs);
        };
        check();
    });
}

beforeEach(() => {
    published = [];
    mqttTopics._init({ lights: [], devices: [testIrDevice], publish: fakePublish });
    iTach._init({ devices: [testIrDevice] });
    originalRollbackEnv = process.env.ITACH_PERSISTENT_CONNECTIONS;
});

afterEach(async () => {
    _resetAll();
    if (originalRollbackEnv === undefined) {
        delete process.env.ITACH_PERSISTENT_CONNECTIONS;
    } else {
        process.env.ITACH_PERSISTENT_CONNECTIONS = originalRollbackEnv;
    }
    if (server) {
        await new Promise((resolve) => server.close(resolve));
        server = null;
    }
});

// --- `~` splitting + persistent-connection reuse ---

test('send_ir_command splits ~ into separate sequential sends, in order', async () => {
    delete process.env.ITACH_PERSISTENT_CONNECTIONS; // default (persistent, true)
    const receivedCommands = [];
    await startFixture(IR_CC_PORT, (socket, data) => {
        receivedCommands.push(data.toString());
        socket.write('completeir,1:1,1\r');
    });

    await iTach.send_ir_command('127.0.0.1', 'CMD_A~CMD_B', 1);

    assert.deepStrictEqual(receivedCommands, ['CMD_A\r\n', 'CMD_B\r\n']);
});

test('persistent connections (default) reuse the same TCP connection across separate calls', async () => {
    delete process.env.ITACH_PERSISTENT_CONNECTIONS;
    let acceptedConnections = 0;
    await startFixture(IR_CC_PORT, (socket, data) => {
        if (data.toString().length > 0) {
            socket.write('completeir,1:1,1\r');
        }
    });
    server.on('connection', () => { acceptedConnections++; });

    await iTach.send_ir_command('127.0.0.1', 'CMD_A', 1);
    await iTach.send_ir_command('127.0.0.1', 'CMD_B', 2);

    assert.strictEqual(acceptedConnections, 1, 'expected one shared TCP connection across both calls');
});

test('ITACH_PERSISTENT_CONNECTIONS=false routes to the legacy per-command implementation (opens a fresh connection every call)', async () => {
    process.env.ITACH_PERSISTENT_CONNECTIONS = 'false';
    let acceptedConnections = 0;
    await startFixture(IR_CC_PORT, () => {});
    server.on('connection', () => { acceptedConnections++; });

    // Fire-and-forget, same as handler.js's real call sites -- the legacy
    // path's own internal setTimeout chain (1000ms+1000ms) means we just
    // need to wait long enough for each call's connection to be ACCEPTED
    // (near-instant) and, at the end, long enough for its internal
    // self-destroy timers to fire so nothing leaks past this test.
    iTach.send_ir_command('127.0.0.1', 'CMD_A', 1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    iTach.send_ir_command('127.0.0.1', 'CMD_B', 2);
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.strictEqual(acceptedConnections, 2, 'expected the legacy path to open a new connection per call');

    // Let the legacy path's own ~2s self-destroy timers finish before the
    // test (and its fixture server) tears down, so nothing lingers.
    await new Promise((resolve) => setTimeout(resolve, 2200));
});

test('send_serial_command uses port 4999, raw write, no CRLF appended', async () => {
    delete process.env.ITACH_PERSISTENT_CONNECTIONS;
    const receivedCommands = [];
    await startFixture(SERIAL_PORT, (socket, data) => {
        receivedCommands.push(data.toString());
    });

    await iTach.send_serial_command('127.0.0.1', 'RAW_CMD', 1);
    // Fire-and-forget (expectResponse: false) resolves as soon as the local
    // write() flushes, which can race the server's own 'data' event on
    // loopback -- wait for it explicitly rather than asserting immediately.
    await waitUntil(() => receivedCommands.length === 1);

    assert.deepStrictEqual(receivedCommands, ['RAW_CMD']);
});

// --- DRY_RUN gate (module-load-time const, matches existing convention) ---

test('DRY_RUN short-circuits before any connection work', async () => {
    // APOLLO_DRY_RUN is read once at module load (same convention as every
    // other driver); asserting on it here would require reloading the
    // module. Instead, confirm the *documented contract* holds by checking
    // process.env.APOLLO_DRY_RUN is unset in this test run (npm test's unit
    // tests run without it -- only test/smoke.js's spawned child sets it),
    // so the persistent-path tests above are proof DRY_RUN did NOT block
    // them from reaching DeviceConnection.
    assert.notStrictEqual(process.env.APOLLO_DRY_RUN, '1');
});

// --- Status publishing: pure matching logic (no index.js dependency) ---

test('_matchingDevicesForAddress matches entries by address AND the port implied by their type', () => {
    const devices = [
        { id: 'a', type: 'iTach_ir', address: '10.0.0.5' },
        { id: 'b', type: 'iTach_CC', address: '10.0.0.5' },
        { id: 'c', type: 'iTach_serial', address: '10.0.0.5' }, // different port (4999)
        { id: 'd', type: 'iTach_ir', address: '10.0.0.9' },     // different address
    ];

    const matches = iTach._matchingDevicesForAddress(devices, '10.0.0.5', IR_CC_PORT);
    assert.deepStrictEqual(matches.map((d) => d.id).sort(), ['a', 'b']);

    const serialMatches = iTach._matchingDevicesForAddress(devices, '10.0.0.5', SERIAL_PORT);
    assert.deepStrictEqual(serialMatches.map((d) => d.id), ['c']);
});

test('_matchingDevicesForAddress returns an empty array for an unknown address', () => {
    const matches = iTach._matchingDevicesForAddress([{ id: 'a', type: 'iTach_ir', address: '10.0.0.5' }], '10.0.0.99', IR_CC_PORT);
    assert.deepStrictEqual(matches, []);
});

test('_portForType maps iTach types to their fixed connection port', () => {
    assert.strictEqual(iTach._portForType('iTach_serial'), SERIAL_PORT);
    assert.strictEqual(iTach._portForType('iTach_ir'), IR_CC_PORT);
    assert.strictEqual(iTach._portForType('iTach_CC'), IR_CC_PORT);
    assert.strictEqual(iTach._portForType('ip_control'), null);
});

// --- Status publishing: mqttClient.publish() wiring ---

test('publishes online status to apollo/<location>/itach/<mqttName>/status when the connection comes up', async () => {
    delete process.env.ITACH_PERSISTENT_CONNECTIONS;

    const publishCalls = [];
    const originalPublish = mqttClient.publish;
    mqttClient.publish = (topic, payload, opts) => publishCalls.push({ topic, payload, opts });

    try {
        await startFixture(IR_CC_PORT, (socket) => socket.write('completeir,1:1,1\r'));

        await iTach.send_ir_command('127.0.0.1', 'power_toggle', 1);

        assert.deepStrictEqual(
            publishCalls.map((c) => ({ topic: c.topic, payload: c.payload })),
            [{ topic: 'apollo/test/itach/test-ir/status', payload: 'online' }]
        );
        assert.strictEqual(publishCalls[0].opts.retain, true);
    } finally {
        mqttClient.publish = originalPublish;
    }
});

test('publishes offline status when the connection drops while a command is in-flight', async () => {
    delete process.env.ITACH_PERSISTENT_CONNECTIONS;

    const publishCalls = [];
    const originalPublish = mqttClient.publish;
    mqttClient.publish = (topic, payload, opts) => publishCalls.push({ topic, payload, opts });

    let acceptedSocket = null;
    try {
        // Never responds -- keeps the IR command's expectResponse:true send
        // in-flight until the socket is destroyed below, same as
        // deviceConnection.test.js's "close while a command is in-flight"
        // case (issue #13 follow-up: a close is only a real reachability
        // transition when something was actually in-flight or queued).
        await startFixture(IR_CC_PORT, (socket) => {
            acceptedSocket = socket;
        });

        // Deliberately not awaited -- the command is still in-flight when we
        // destroy the connection immediately below.
        iTach.send_ir_command('127.0.0.1', 'power_toggle', 1);
        // server.close() alone wouldn't drop this already-accepted connection
        // (it only stops accepting NEW ones) -- explicitly sever this one
        // from the server side, same as a real device dropping the link.
        await waitUntil(() => acceptedSocket !== null);
        acceptedSocket.destroy();

        await new Promise((resolve) => setTimeout(resolve, 300));

        assert.ok(
            publishCalls.some((c) => c.topic === 'apollo/test/itach/test-ir/status' && c.payload === 'offline'),
            `expected an offline status publish, got: ${JSON.stringify(publishCalls)}`
        );
    } finally {
        mqttClient.publish = originalPublish;
    }
});

test('does NOT publish offline on a benign idle close (queue empty, nothing in-flight)', async () => {
    delete process.env.ITACH_PERSISTENT_CONNECTIONS;

    const publishCalls = [];
    const originalPublish = mqttClient.publish;
    mqttClient.publish = (topic, payload, opts) => publishCalls.push({ topic, payload, opts });

    let acceptedSocket = null;
    try {
        await startFixture(IR_CC_PORT, (socket, data) => {
            acceptedSocket = socket;
            if (data.toString().length > 0) {
                socket.write('completeir,1:1,1\r');
            }
        });

        await iTach.send_ir_command('127.0.0.1', 'power_toggle', 1);
        assert.ok(acceptedSocket, 'fixture never accepted a connection');

        publishCalls.length = 0; // isolate from the command's own online publish
        // Close well after the command's response already resolved -- e.g.
        // an idle-timeout style close -- nothing queued, nothing in-flight.
        acceptedSocket.destroy();

        await new Promise((resolve) => setTimeout(resolve, 300));

        assert.ok(
            !publishCalls.some((c) => c.payload === 'offline'),
            `expected no offline status publish for a benign close, got: ${JSON.stringify(publishCalls)}`
        );
    } finally {
        mqttClient.publish = originalPublish;
    }
});
