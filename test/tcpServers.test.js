/**
 * Unit tests for src/tcpServers.js's persistent-connection send_ip_command
 * (Stage 5 of documentation/mqtt-implementation-detail.md, issue #13).
 *
 * All fixtures are local `net.createServer` instances bound to 127.0.0.1 on
 * ephemeral ports -- loopback only, no real device or the Pi is ever
 * touched, per the Stage 5 safety constraint.
 *
 * mqttTopics.js is wired to a fixture device via `_init({ lights, devices,
 * publish })`, same pattern as test/lightingShelly.test.js. Unlike
 * iTachControllers.js, tcpServers.js's status publisher closes directly over
 * the device_info passed to send_ip_command (no reverse index.js lookup), so
 * no extra test hook is needed there -- see the module doc comment on
 * registerStatusPublisher in src/tcpServers.js.
 */

const assert = require('node:assert');
const { test, beforeEach, afterEach } = require('node:test');
const net = require('net');

const mqttTopics = require('../src/mqttTopics');
const { _resetAll } = require('../src/deviceConnection');
const tcpServers = require('../src/tcpServers');

let published;
function fakePublish(topic, payload, opts) {
    published.push({ topic, payload, opts });
}

let server = null;
let originalRollbackEnv;

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

/**
 * A tiny stateful fixture emulating a PJLink-ish "power query / on / off"
 * protocol over a `\r`-terminated wire, matching the shape of the real
 * theaterProjector/anthem config entries (power_query / power_response_on /
 * power_response_off / commands.on / commands.off). Records every raw
 * command received (already `\r`-terminator-included, since these devices'
 * command language embeds `\r` itself) and answers power queries with its
 * current in-memory state.
 *
 * `wireTerminator` (default `\r`) controls how incoming commands are split
 * off the wire -- pass `';'` to emulate an Anthem-style device whose whole
 * command language (not just the response) is `;`-terminated with no `\r`
 * anywhere, per issue #13's follow-up fix.
 *
 * `extraResponses` (optional) is a plain `{ cmd: response }` map for
 * additional query/response pairs beyond power (e.g. the Anthem's
 * `Z1VOL?;`/`Z1INP?;`/`Z1MUT?;` speaker-state queries) -- lets a single
 * fixture answer several independent single-field queries the way the real
 * receiver does when tcpServers.js's queryAnthemSpeakerExtras() sends them
 * one round trip at a time.
 */
function startPowerAwareFixture(port, { queryCmd, onCmd, offCmd, onResponse, offResponse, initialState = 'off', wireTerminator = '\r', extraResponses = {} }) {
    let state = initialState;
    const received = [];
    return new Promise((resolve) => {
        server = net.createServer((socket) => {
            socket.on('error', () => {});
            let buffer = '';
            socket.on('data', (data) => {
                buffer += data.toString();
                let idx;
                while ((idx = buffer.indexOf(wireTerminator)) !== -1) {
                    const cmd = buffer.slice(0, idx + wireTerminator.length);
                    buffer = buffer.slice(idx + wireTerminator.length);
                    received.push(cmd);
                    if (cmd === queryCmd) {
                        socket.write(state === 'on' ? onResponse : offResponse);
                    } else if (cmd === onCmd) {
                        state = 'on';
                    } else if (cmd === offCmd) {
                        state = 'off';
                    } else if (Object.prototype.hasOwnProperty.call(extraResponses, cmd)) {
                        socket.write(extraResponses[cmd]);
                    }
                }
            });
            socket.resume();
        });
        server.on('error', () => {});
        server.listen(port, '127.0.0.1', () => {
            resolve({ received, getState: () => state, port: server.address().port });
        });
    });
}

beforeEach(() => {
    published = [];
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

// --- parsePowerResponse: PJLink and Anthem-style shapes ---

test('parsePowerResponse matches a PJLink-style response (config value embeds a trailing \\r)', () => {
    const device = {
        power_commands: {
            power_response_on: '%1POWR=1\r',
            power_response_off: '%1POWR=0\r',
        },
    };
    // The connection's framing already strips the trailing \r before this
    // function ever sees the response.
    assert.strictEqual(tcpServers.parsePowerResponse(device, '%1POWR=1'), 'ON');
    assert.strictEqual(tcpServers.parsePowerResponse(device, '%1POWR=0'), 'OFF');
    assert.strictEqual(tcpServers.parsePowerResponse(device, '%1POWR=9'), null);
});

test('parsePowerResponse matches an Anthem-style response (config value has no trailing \\r)', () => {
    const device = {
        power_commands: {
            power_response_on: 'Z1POW1;',
            power_response_off: 'Z1POW0;',
        },
    };
    assert.strictEqual(tcpServers.parsePowerResponse(device, 'Z1POW1;'), 'ON');
    assert.strictEqual(tcpServers.parsePowerResponse(device, 'Z1POW0;'), 'OFF');
});

test('parsePowerResponse returns null for a null/undefined/unrecognized response', () => {
    const device = { power_commands: { power_response_on: 'ON;', power_response_off: 'OFF;' } };
    assert.strictEqual(tcpServers.parsePowerResponse(device, null), null);
    assert.strictEqual(tcpServers.parsePowerResponse(device, undefined), null);
    assert.strictEqual(tcpServers.parsePowerResponse(device, 'GARBAGE'), null);
});

// --- deriveTerminator ---

test('deriveTerminator returns \';\' when power_response_on ends with \';\' (Anthem-style)', () => {
    const device = { power_commands: { power_response_on: 'Z1POW1;', power_response_off: 'Z1POW0;' } };
    assert.strictEqual(tcpServers.deriveTerminator(device), ';');
});

test('deriveTerminator returns \'\\r\' when power_response_on ends with \'\\r\' (PJLink-style)', () => {
    const device = { power_commands: { power_response_on: '%1POWR=1\r', power_response_off: '%1POWR=0\r' } };
    assert.strictEqual(tcpServers.deriveTerminator(device), '\r');
});

test('deriveTerminator defaults to \'\\r\' when there are no power_commands at all', () => {
    const device = { commands: {} };
    assert.strictEqual(tcpServers.deriveTerminator(device), '\r');
});

// --- send_ip_command: power-check state machine ---

test('Anthem-style device (`;`-terminated, no \\r): terminal derived as \';\' and the power-check round trip completes', async () => {
    delete process.env.ITACH_PERSISTENT_CONNECTIONS;
    const { received, port } = await startPowerAwareFixture(0, {
        queryCmd: 'Z1POW?;',
        onCmd: 'Z1POW1;',
        offCmd: 'Z1POW0;',
        onResponse: 'Z1POW1;', // no \r -- this is exactly the live-hardware bug (#13 follow-up)
        offResponse: 'Z1POW0;',
        initialState: 'off',
        wireTerminator: ';',
    });

    const device = {
        id: 'anthem',
        type: 'ip_control',
        address: '127.0.0.1',
        port,
        location: 'theater',
        mqttName: 'anthem',
        commands: { on: 'Z1POW1;', off: 'Z1POW0;', input1: 'Z1INP1;' },
        power_commands: {
            power_query: 'Z1POW?;',
            power_response_on: 'Z1POW1;',
            power_response_off: 'Z1POW0;',
            power_on_delay: 10,
            power_off_delay: 10,
        },
    };
    mqttTopics._init({ lights: [], devices: [device], publish: fakePublish });

    assert.strictEqual(tcpServers.deriveTerminator(device), ';');

    await tcpServers.send_ip_command(1, device, device.commands.input1, true);
    await waitUntil(() => received.length >= 3);

    assert.deepStrictEqual(received, ['Z1POW?;', 'Z1POW1;', 'Z1INP1;']);
    assert.ok(published.some((p) => p.payload.power === 'ON'), `expected a power:ON publish, got ${JSON.stringify(published)}`);
});

// --- Anthem speaker state (volume/input/mute) -- Dashboard increment 4 ---

test('parseAnthemSpeakerState extracts power/volume/input/mute from a fully concatenated buffer', () => {
    const state = tcpServers.parseAnthemSpeakerState('Z1POW1;Z1VOL-36;Z1INP5;Z1MUT0;');
    assert.deepStrictEqual(state, { power: 'ON', volume: -36, input: 5, mute: false });
});

test('parseAnthemSpeakerState tolerates zero-padded input (Z1INP05, as the SET command uses) same as the unpadded query reply', () => {
    assert.deepStrictEqual(tcpServers.parseAnthemSpeakerState('Z1INP05'), { input: 5 });
    assert.deepStrictEqual(tcpServers.parseAnthemSpeakerState('Z1INP5'), { input: 5 });
});

test('parseAnthemSpeakerState parses power OFF and mute ON', () => {
    assert.deepStrictEqual(tcpServers.parseAnthemSpeakerState('Z1POW0;Z1MUT1;'), { power: 'OFF', mute: true });
});

test('parseAnthemSpeakerState returns {} for null/undefined/no-match input', () => {
    assert.deepStrictEqual(tcpServers.parseAnthemSpeakerState(null), {});
    assert.deepStrictEqual(tcpServers.parseAnthemSpeakerState(undefined), {});
    assert.deepStrictEqual(tcpServers.parseAnthemSpeakerState('GARBAGE'), {});
});

test('queryAnthemSpeakerExtras returns {} immediately for a device with no `speaker` block (the projector)', async () => {
    const result = await tcpServers.queryAnthemSpeakerExtras({}, { commands: {} });
    assert.deepStrictEqual(result, {});
});

test('send_ip_command power-check on an Anthem-shaped device also queries+publishes volume/input/mute', async () => {
    delete process.env.ITACH_PERSISTENT_CONNECTIONS;
    const { received, port } = await startPowerAwareFixture(0, {
        queryCmd: 'Z1POW?;',
        onCmd: 'Z1POW1;',
        offCmd: 'Z1POW0;',
        onResponse: 'Z1POW1;',
        offResponse: 'Z1POW0;',
        initialState: 'on',
        wireTerminator: ';',
        extraResponses: {
            'Z1VOL?;': 'Z1VOL-36;',
            'Z1INP?;': 'Z1INP5;',
            'Z1MUT?;': 'Z1MUT0;',
        },
    });

    const device = {
        id: 'anthem',
        type: 'ip_control',
        address: '127.0.0.1',
        port,
        location: 'theater',
        mqttName: 'anthem',
        commands: { on: 'Z1POW1;', off: 'Z1POW0;', input_query: 'Z1INP?;', vol_up: 'Z1VUP05;' },
        power_commands: {
            power_query: 'Z1POW?;',
            power_response_on: 'Z1POW1;',
            power_response_off: 'Z1POW0;',
            power_on_delay: 10,
            power_off_delay: 10,
        },
        speaker: {
            volumeQuery: 'Z1VOL?;',
        },
    };
    mqttTopics._init({ lights: [], devices: [device], publish: fakePublish });

    await tcpServers.send_ip_command(1, device, device.commands.vol_up, true);
    await waitUntil(() => received.length >= 5);

    assert.deepStrictEqual(received, ['Z1POW?;', 'Z1VUP05;', 'Z1VOL?;', 'Z1INP?;', 'Z1MUT?;']);

    const publishedState = published.find((p) => p.payload.power === 'ON' && 'volume' in p.payload);
    assert.ok(publishedState, `expected a merged power+volume+input+mute publish, got ${JSON.stringify(published)}`);
    assert.strictEqual(publishedState.payload.power, 'ON');
    assert.strictEqual(publishedState.payload.volume, -36);
    assert.strictEqual(publishedState.payload.input, 5);
    assert.strictEqual(publishedState.payload.mute, false);
});

test('send_ip_command power-check on the projector (no `speaker` block) does NOT send any extra queries', async () => {
    delete process.env.ITACH_PERSISTENT_CONNECTIONS;
    const { received, port } = await startPowerAwareFixture(0, {
        queryCmd: '%1POWR ?\r',
        onCmd: '%1POWR 1\r',
        offCmd: '%1POWR 0\r',
        onResponse: '%1POWR=1\r',
        offResponse: '%1POWR=0\r',
        initialState: 'on',
    });

    const device = {
        id: 'projector',
        type: 'ip_control',
        address: '127.0.0.1',
        port,
        commands: { on: '%1POWR 1\r', off: '%1POWR 0\r', input1: '%1INPT 21\r' },
        power_commands: {
            power_query: '%1POWR ?\r',
            power_response_on: '%1POWR=1\r',
            power_response_off: '%1POWR=0\r',
        },
    };
    mqttTopics._init({ lights: [], devices: [device], publish: fakePublish });

    await tcpServers.send_ip_command(1, device, device.commands.input1, true);
    await waitUntil(() => received.length >= 2);
    // Give a beat to make sure nothing extra shows up beyond query + command.
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.deepStrictEqual(received, ['%1POWR ?\r', '%1INPT 21\r']);
    const publishedState = published.find((p) => p.payload.power === 'ON');
    assert.ok(publishedState);
    assert.strictEqual('volume' in publishedState.payload, false);
    assert.strictEqual('input' in publishedState.payload, false);
    assert.strictEqual('mute' in publishedState.payload, false);
});

test('PJLink-style device (`\\r`-terminated) still round-trips correctly alongside the Anthem terminator handling', async () => {
    delete process.env.ITACH_PERSISTENT_CONNECTIONS;
    const { received, port } = await startPowerAwareFixture(0, {
        queryCmd: '%1POWR ?\r',
        onCmd: '%1POWR 1\r',
        offCmd: '%1POWR 0\r',
        onResponse: '%1POWR=1\r',
        offResponse: '%1POWR=0\r',
        initialState: 'on',
        wireTerminator: '\r',
    });

    const device = {
        id: 'projector',
        type: 'ip_control',
        address: '127.0.0.1',
        port,
        commands: { on: '%1POWR 1\r', off: '%1POWR 0\r', input1: '%1INPT 21\r' },
        power_commands: {
            power_query: '%1POWR ?\r',
            power_response_on: '%1POWR=1\r',
            power_response_off: '%1POWR=0\r',
        },
    };
    mqttTopics._init({ lights: [], devices: [device], publish: fakePublish });

    assert.strictEqual(tcpServers.deriveTerminator(device), '\r');

    await tcpServers.send_ip_command(1, device, device.commands.input1, true);
    await waitUntil(() => received.length >= 2);

    assert.deepStrictEqual(received, ['%1POWR ?\r', '%1INPT 21\r']);
    assert.ok(published.some((p) => p.payload.power === 'ON'));
});

test('device is off and command is not OFF: turns it on, then sends the command, and publishes power ON', async () => {
    delete process.env.ITACH_PERSISTENT_CONNECTIONS;
    const { received, port } = await startPowerAwareFixture(0, {
        queryCmd: '%1POWR ?\r',
        onCmd: '%1POWR 1\r',
        offCmd: '%1POWR 0\r',
        onResponse: '%1POWR=1\r',
        offResponse: '%1POWR=0\r',
        initialState: 'off',
    });

    const device = {
        id: 'projector',
        type: 'ip_control',
        address: '127.0.0.1',
        port,
        location: 'theater',
        mqttName: 'projector',
        commands: { on: '%1POWR 1\r', off: '%1POWR 0\r', input1: '%1INPT 21\r' },
        power_commands: {
            power_query: '%1POWR ?\r',
            power_response_on: '%1POWR=1\r',
            power_response_off: '%1POWR=0\r',
            power_on_delay: 10,
            power_off_delay: 10,
        },
    };
    mqttTopics._init({ lights: [], devices: [device], publish: fakePublish });

    await tcpServers.send_ip_command(1, device, device.commands.input1, true);
    await waitUntil(() => received.length >= 3);

    assert.deepStrictEqual(received, ['%1POWR ?\r', '%1POWR 1\r', '%1INPT 21\r']);
    assert.ok(published.some((p) => p.payload.power === 'ON'), `expected a power:ON publish, got ${JSON.stringify(published)}`);
});

test('device is on and command is not ON: sends the command directly (no power toggle)', async () => {
    delete process.env.ITACH_PERSISTENT_CONNECTIONS;
    const { received, port } = await startPowerAwareFixture(0, {
        queryCmd: '%1POWR ?\r',
        onCmd: '%1POWR 1\r',
        offCmd: '%1POWR 0\r',
        onResponse: '%1POWR=1\r',
        offResponse: '%1POWR=0\r',
        initialState: 'on',
    });

    const device = {
        id: 'projector',
        type: 'ip_control',
        address: '127.0.0.1',
        port,
        commands: { on: '%1POWR 1\r', off: '%1POWR 0\r', input1: '%1INPT 21\r' },
        power_commands: {
            power_query: '%1POWR ?\r',
            power_response_on: '%1POWR=1\r',
            power_response_off: '%1POWR=0\r',
        },
    };
    mqttTopics._init({ lights: [], devices: [device], publish: fakePublish });

    await tcpServers.send_ip_command(1, device, device.commands.input1, true);
    await waitUntil(() => received.length >= 2);

    assert.deepStrictEqual(received, ['%1POWR ?\r', '%1INPT 21\r']);
    assert.ok(published.some((p) => p.payload.power === 'ON'));
});

test("device is off and command is OFF: disregards without turning it on", async () => {
    delete process.env.ITACH_PERSISTENT_CONNECTIONS;
    const { received, getState, port } = await startPowerAwareFixture(0, {
        queryCmd: '%1POWR ?\r',
        onCmd: '%1POWR 1\r',
        offCmd: '%1POWR 0\r',
        onResponse: '%1POWR=1\r',
        offResponse: '%1POWR=0\r',
        initialState: 'off',
    });

    const device = {
        id: 'projector',
        type: 'ip_control',
        address: '127.0.0.1',
        port,
        commands: { on: '%1POWR 1\r', off: '%1POWR 0\r' },
        power_commands: {
            power_query: '%1POWR ?\r',
            power_response_on: '%1POWR=1\r',
            power_response_off: '%1POWR=0\r',
        },
    };
    mqttTopics._init({ lights: [], devices: [device], publish: fakePublish });

    await tcpServers.send_ip_command(1, device, 'OFF', true);
    await waitUntil(() => received.length >= 1);
    // Give a beat to make sure nothing ELSE arrives beyond the query.
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.deepStrictEqual(received, ['%1POWR ?\r']);
    assert.strictEqual(getState(), 'off');
    assert.ok(published.some((p) => p.payload.power === 'OFF'));
});

test('~-delimited commands are sent in order, spaced, without a power check', async () => {
    delete process.env.ITACH_PERSISTENT_CONNECTIONS;
    const received = [];
    await new Promise((resolve) => {
        server = net.createServer((socket) => {
            socket.on('error', () => {});
            socket.on('data', (data) => received.push(data.toString()));
            socket.resume();
        });
        server.listen(0, '127.0.0.1', resolve);
    });
    const port = server.address().port;

    const device = { id: 'plain', type: 'ip_control', address: '127.0.0.1', port, commands: {} };
    mqttTopics._init({ lights: [], devices: [device], publish: fakePublish });

    await tcpServers.send_ip_command(1, device, 'CMD_A~CMD_B', false);
    await waitUntil(() => received.length === 2);

    assert.deepStrictEqual(received, ['CMD_A', 'CMD_B']);
});

// --- Status publishing ---

test('publishes unreachable state when the connection drops while a command is in-flight', async () => {
    delete process.env.ITACH_PERSISTENT_CONNECTIONS;
    let acceptedSocket = null;
    await new Promise((resolve) => {
        server = net.createServer((socket) => {
            acceptedSocket = socket;
            socket.on('error', () => {});
            socket.resume(); // never responds -- the power query stays in-flight
        });
        server.listen(0, '127.0.0.1', resolve);
    });
    const port = server.address().port;

    const device = {
        id: 'plain', type: 'ip_control', address: '127.0.0.1', port,
        commands: { on: 'ON\r', off: 'OFF\r' },
        power_commands: { power_query: 'QUERY\r', power_response_on: 'ON\r', power_response_off: 'OFF\r' },
    };
    mqttTopics._init({ lights: [], devices: [device], publish: fakePublish });

    // Deliberately not awaited -- the power-check query is in-flight
    // (awaiting a response the fixture never sends) when the socket is
    // destroyed below, which is the scenario this test targets.
    tcpServers.send_ip_command(1, device, 'SOME_CMD', true);
    // The client's send() can resolve/queue before the server's own
    // 'connection' handler has necessarily run (they're independent callback
    // chains -- under load, from other test files running in parallel, this
    // otherwise-rare race becomes easy to hit), so wait for it explicitly
    // rather than asserting immediately.
    await waitUntil(() => acceptedSocket !== null);

    published = []; // isolate from the command's own publishes (there are none here, but be explicit)
    acceptedSocket.destroy();

    await waitUntil(() => published.some((p) => p.payload.reachable === false));
    assert.ok(published.some((p) => p.topic.endsWith('/state') && p.payload.reachable === false));
});

test('does NOT publish unreachable on a benign idle close (queue empty, nothing in-flight)', async () => {
    delete process.env.ITACH_PERSISTENT_CONNECTIONS;
    let acceptedSocket = null;
    await new Promise((resolve) => {
        server = net.createServer((socket) => {
            acceptedSocket = socket;
            socket.on('error', () => {});
            socket.resume();
        });
        server.listen(0, '127.0.0.1', resolve);
    });
    const port = server.address().port;

    const device = { id: 'plain', type: 'ip_control', address: '127.0.0.1', port, commands: {} };
    mqttTopics._init({ lights: [], devices: [device], publish: fakePublish });

    // Fire-and-forget: send_ip_command's own promise resolves right after
    // write, well before this close happens, so nothing is queued or
    // in-flight -- mirrors a device closing an idle connection server-side.
    await tcpServers.send_ip_command(1, device, 'CMD_A', false);
    await waitUntil(() => acceptedSocket !== null);

    published = [];
    acceptedSocket.destroy();

    // Give the close time to propagate; there should be no unreachable publish.
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.ok(
        !published.some((p) => p.payload.reachable === false),
        `expected no unreachable publish for a benign close, got ${JSON.stringify(published)}`
    );
});

// --- Legacy-flag routing ---

test('ITACH_PERSISTENT_CONNECTIONS=false routes to the legacy per-command implementation (opens a fresh connection every call)', async () => {
    process.env.ITACH_PERSISTENT_CONNECTIONS = 'false';
    let acceptedConnections = 0;
    await new Promise((resolve) => {
        server = net.createServer((socket) => {
            acceptedConnections++;
            socket.on('error', () => {});
            socket.resume();
        });
        server.listen(0, '127.0.0.1', resolve);
    });
    const port = server.address().port;

    const device = { id: 'plain', type: 'ip_control', address: '127.0.0.1', port, commands: {} };
    mqttTopics._init({ lights: [], devices: [device], publish: fakePublish });

    tcpServers.send_ip_command(1, device, 'CMD_A', false);
    await waitUntil(() => acceptedConnections >= 1);
    tcpServers.send_ip_command(2, device, 'CMD_B', false);
    await waitUntil(() => acceptedConnections >= 2);

    assert.strictEqual(acceptedConnections, 2, 'expected the legacy path to open a new connection per call');

    // Let the legacy path's own ~1s self-destroy timer finish before the
    // test (and its fixture server) tears down.
    await new Promise((resolve) => setTimeout(resolve, 1200));
});

// --- DRY_RUN gate (module-load-time const, matches existing convention) ---

test('DRY_RUN is unset in the unit-test run (only test/smoke.js sets it for its spawned child)', () => {
    assert.notStrictEqual(process.env.APOLLO_DRY_RUN, '1');
});
