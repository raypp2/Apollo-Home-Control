/**
 * Unit tests for src/deviceConnection.js -- the shared persistent-TCP layer
 * introduced in Stage 5 of documentation/mqtt-implementation-detail.md
 * (issue #13).
 *
 * All fixtures are local `net.createServer` instances bound to 127.0.0.1 on
 * ephemeral (or, for the "nothing listening" cases, well-known-refused)
 * ports -- these tests NEVER touch a real device or the Pi, per the Stage 5
 * safety constraint (iTach controllers only accept one TCP client per port,
 * so even a "read-only" probe against real hardware could break Ray's
 * running setup). Every DeviceConnection created here is destroy()'d in
 * afterEach, and every fixture server is closed, so no listener/socket is
 * left behind once the file finishes.
 */

const assert = require('node:assert');
const { test, afterEach } = require('node:test');
const net = require('net');

const { DeviceConnection, getConnection, _resetAll } = require('../src/deviceConnection');

let activeConnections = [];
let activeServers = [];

function trackConn(conn) {
    activeConnections.push(conn);
    return conn;
}

function startFixtureServer(onConnection) {
    return new Promise((resolve) => {
        const server = net.createServer((socket) => {
            // Defensive: an accepted socket with zero listeners throws
            // uncaught on 'error' (e.g. ECONNRESET when the client side is
            // destroy()'d in afterEach) -- always have one, regardless of
            // whether the test's own onConnection callback adds its own.
            socket.on('error', () => {});
            if (onConnection) {
                onConnection(socket, server);
            }
            // Always put the socket in flowing mode, even for fixtures that
            // don't care about the data (e.g. "never responds" timeout
            // fixtures). A server-side socket that received bytes but was
            // never resumed/drained will never emit 'close' once the client
            // disconnects, which hangs server.close()'s callback forever --
            // this bit us directly while writing these tests.
            socket.resume();
        });
        server.on('error', () => {});
        server.listen(0, '127.0.0.1', () => {
            activeServers.push(server);
            resolve({ server, port: server.address().port });
        });
    });
}

function waitUntil(conditionFn, { timeoutMs = 2000, intervalMs = 15 } = {}) {
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

afterEach(async () => {
    for (const conn of activeConnections) {
        conn.destroy();
    }
    activeConnections = [];
    _resetAll();
    for (const server of activeServers) {
        await new Promise((resolve) => server.close(resolve));
    }
    activeServers = [];
});

// --- FIFO serialization + inter-command spacing ---

test('serializes two sends in FIFO order with the configured inter-command spacing', async () => {
    const received = [];
    const { port } = await startFixtureServer((socket) => {
        socket.on('data', (data) => {
            received.push({ cmd: data.toString(), t: Date.now() });
        });
    });

    const conn = trackConn(new DeviceConnection({ host: '127.0.0.1', port, spacingMs: 100 }));

    await Promise.all([conn.send('CMD1'), conn.send('CMD2')]);
    await waitUntil(() => received.length === 2);

    assert.strictEqual(received[0].cmd, 'CMD1');
    assert.strictEqual(received[1].cmd, 'CMD2');
    const gap = received[1].t - received[0].t;
    assert.ok(gap >= 90, `expected >=90ms spacing between commands, got ${gap}ms`);
});

test('a single in-flight command at a time -- a second send is not written until the first resolves', async () => {
    const writeOrder = [];
    let firstResolved = false;
    const { port } = await startFixtureServer((socket) => {
        socket.on('data', (data) => {
            writeOrder.push(data.toString());
        });
    });

    const conn = trackConn(new DeviceConnection({ host: '127.0.0.1', port, spacingMs: 20 }));

    const p1 = conn.send('FIRST').then((r) => { firstResolved = true; return r; });
    // Fire the second send immediately -- it must queue, not race the first.
    const p2 = conn.send('SECOND');

    await p1;
    assert.strictEqual(firstResolved, true);
    await p2;
    await waitUntil(() => writeOrder.length === 2);
    assert.deepStrictEqual(writeOrder, ['FIRST', 'SECOND']);
});

// --- Response framing + timeout ---

test('resolves with the response framed up to (and excluding) the \\r terminator', async () => {
    const { port } = await startFixtureServer((socket) => {
        socket.on('data', (data) => {
            if (data.toString() === 'QUERY') {
                socket.write('RESULT=OK\r');
            }
        });
    });

    const conn = trackConn(new DeviceConnection({ host: '127.0.0.1', port }));
    const response = await conn.send('QUERY', { expectResponse: true, timeoutMs: 1000 });
    assert.strictEqual(response, 'RESULT=OK');
});

test('the default \\r terminator still works when passed explicitly', async () => {
    const { port } = await startFixtureServer((socket) => {
        socket.on('data', (data) => {
            if (data.toString() === 'QUERY') {
                socket.write('RESULT=OK\r');
            }
        });
    });

    const conn = trackConn(new DeviceConnection({ host: '127.0.0.1', port, terminator: '\r' }));
    const response = await conn.send('QUERY', { expectResponse: true, timeoutMs: 1000 });
    assert.strictEqual(response, 'RESULT=OK');
});

test('frames responses on a `;`-terminator (Anthem-style, no \\r at all) when configured', async () => {
    const { port } = await startFixtureServer((socket) => {
        socket.on('data', (data) => {
            if (data.toString() === 'Z1POW?;') {
                socket.write('Z1POW1;'); // no \r -- this is the whole point of the terminator option
            }
        });
    });

    const conn = trackConn(new DeviceConnection({ host: '127.0.0.1', port, terminator: ';' }));
    const response = await conn.send('Z1POW?;', { expectResponse: true, timeoutMs: 1000 });
    assert.strictEqual(response, 'Z1POW1');
});

test('resolves null (not a rejection) when no response arrives before the timeout', async () => {
    // Accepts the connection but never responds.
    const { port } = await startFixtureServer(() => {});

    const conn = trackConn(new DeviceConnection({ host: '127.0.0.1', port, responseTimeoutMs: 80 }));
    const response = await conn.send('QUERY', { expectResponse: true });
    assert.strictEqual(response, null);
});

test('fire-and-forget commands (expectResponse omitted) resolve null right after write', async () => {
    const received = [];
    const { port } = await startFixtureServer((socket) => {
        socket.on('data', (data) => received.push(data.toString()));
    });

    const conn = trackConn(new DeviceConnection({ host: '127.0.0.1', port }));
    const response = await conn.send('FIRE_AND_FORGET');
    assert.strictEqual(response, null);
    await waitUntil(() => received.length === 1);
    assert.strictEqual(received[0], 'FIRE_AND_FORGET');
});

// --- Queue staleness ---

test('drops a queued command as stale (logged) and resolves null if it can never be sent', async () => {
    // Nothing listens on loopback:1 -- connects fail (ECONNREFUSED) almost
    // instantly and repeatedly; the queued command should age out via
    // staleMs well before it's ever written anywhere.
    const conn = trackConn(new DeviceConnection({
        host: '127.0.0.1',
        port: 1,
        staleMs: 80,
        backoffInitialMs: 15,
        backoffMaxMs: 30,
        connectTimeoutMs: 2000,
    }));

    const logs = [];
    const originalLog = console.log;
    console.log = (...args) => logs.push(args.map(String).join(' '));

    let response;
    try {
        response = await conn.send('CMD', { expectResponse: false });
    } finally {
        console.log = originalLog;
    }

    assert.strictEqual(response, null);
    assert.ok(logs.some((l) => l.includes('dropping stale command')), 'expected a stale-drop log line');
});

// --- Reconnect behavior ---

test('benign idle close (queue empty, nothing in-flight): no offline emitted; next send reconnects lazily with no duplicate online', async () => {
    // Mirrors a PJLink projector closing an idle connection ~30s after
    // responding to a command -- by the time the close arrives, the
    // fire-and-forget command that triggered it has long since resolved
    // client-side, so nothing is queued or in-flight.
    let acceptedConnections = 0;
    const { server, port } = await startFixtureServer((socket) => {
        acceptedConnections++;
        const isFirstConnection = acceptedConnections === 1;
        socket.on('data', () => {
            if (isFirstConnection) {
                socket.end();
            }
        });
    });
    void server;

    const statuses = [];
    const conn = trackConn(new DeviceConnection({ host: '127.0.0.1', port, backoffInitialMs: 15, backoffMaxMs: 40 }));
    conn.onStatusChange((s) => statuses.push(s));

    await conn.send('CMD1');
    // The connection recovers on its own -- either via the next send() or
    // the pre-existing proactive backoff-scheduled retry in
    // _maybeScheduleReconnect() (both are legitimate; a status listener is
    // registered here, same as production, so the proactive path is
    // expected to win the race) -- but it must NOT have gone through an
    // 'offline' status to get there.
    await waitUntil(() => acceptedConnections >= 2);
    assert.ok(!statuses.includes('offline'), `expected no offline emission for a benign idle close, got ${JSON.stringify(statuses)}`);

    const response = await conn.send('CMD2');
    assert.strictEqual(response, null); // fire-and-forget, served over the (already, or freshly) reconnected socket
    await waitUntil(() => acceptedConnections >= 2);

    assert.ok(!statuses.includes('offline'), 'still expected no offline after CMD2');
    assert.strictEqual(
        statuses.filter((s) => s === 'online').length, 1,
        `expected only the original online emission, no duplicate on reconnect, got ${JSON.stringify(statuses)}`
    );
});

test('close while a command is in-flight (awaiting a response): offline IS emitted', async () => {
    // The server accepts, then destroys the socket the moment it sees data
    // -- never responds -- so the client's expectResponse:true send is still
    // in-flight (its _activeFinish resolver is set) when the close arrives.
    const { port } = await startFixtureServer((socket) => {
        socket.on('data', () => {
            socket.destroy();
        });
    });

    const statuses = [];
    const conn = trackConn(new DeviceConnection({
        host: '127.0.0.1', port, responseTimeoutMs: 2000, backoffInitialMs: 15, backoffMaxMs: 40,
    }));
    conn.onStatusChange((s) => statuses.push(s));

    const response = await conn.send('QUERY', { expectResponse: true });
    assert.strictEqual(response, null);
    await waitUntil(() => statuses.includes('offline'));

    assert.deepStrictEqual(statuses, ['online', 'offline']);
});

test('connect failure sets status offline and never produces an unhandled promise rejection', async () => {
    // A DeviceConnection starts life already in 'offline' status, so a
    // connection that NEVER succeeds produces no online->offline transition
    // to observe (nothing changed -- transitions-only, same convention as
    // mqttClient.js). To actually exercise the failure path, connect
    // successfully once, then yank the server out from under it so every
    // subsequent reconnect attempt fails with ECONNREFUSED.
    const { server, port } = await startFixtureServer((socket) => {
        socket.destroy(); // drop the connection immediately once accepted
    });

    const conn = trackConn(new DeviceConnection({
        host: '127.0.0.1',
        port,
        staleMs: 5000, // long enough that the test controls its own pacing, not the stale-drop
        connectTimeoutMs: 1000,
        backoffInitialMs: 15,
        backoffMaxMs: 30,
    }));

    const statuses = [];
    conn.onStatusChange((s) => statuses.push(s));

    let unhandled = null;
    const onUnhandledRejection = (reason) => { unhandled = reason; };
    process.on('unhandledRejection', onUnhandledRejection);

    // Deliberately not awaited here -- this is exactly the "fire and forget,
    // never .catch()'d" pattern the no-rejection guarantee protects against.
    // expectResponse:true so the command stays genuinely in-flight (its
    // _activeFinish resolver stays set) until the close/error resolves it --
    // a fire-and-forget send's local socket.write() callback can otherwise
    // fire (clearing in-flight state) before the peer's immediate destroy()
    // is even noticed client-side, since a local write only confirms the
    // kernel accepted the bytes, not that the peer received them. That would
    // make this specific accept-then-destroy race read as a benign close
    // (see the module doc comment) instead of the real failure it is.
    conn.send('CMD', { expectResponse: true });

    try {
        // First transition: connects, is immediately dropped -> offline.
        await waitUntil(() => statuses.includes('offline'), { timeoutMs: 2000 });
        // Now stop listening entirely so every reconnect attempt refuses.
        await new Promise((resolve) => server.close(resolve));
        // Give the microtask queue a beat to surface any unhandled rejection
        // across a few failed reconnect attempts.
        await new Promise((resolve) => setTimeout(resolve, 100));
    } finally {
        process.removeListener('unhandledRejection', onUnhandledRejection);
    }

    assert.strictEqual(unhandled, null);
    assert.ok(statuses.includes('offline'));
});

// --- getConnection() / module-level registry ---

test('getConnection returns the same instance for the same host:port, and a fresh one after _resetAll', async () => {
    const { port } = await startFixtureServer();

    const a = getConnection('127.0.0.1', port, {});
    const b = getConnection('127.0.0.1', port, {});
    assert.strictEqual(a, b);

    _resetAll();

    const c = getConnection('127.0.0.1', port, {});
    trackConn(c);
    assert.notStrictEqual(a, c);
});
