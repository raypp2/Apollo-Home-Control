/**
 * Apollo Home Control Bridge - Device Connection
 * @module deviceConnection.js
 *
 * @description  Shared persistent-TCP-connection layer for GlobalCache iTach
 *               controllers and other raw-TCP "ip_control" devices (Stage 5 of
 *               documentation/mqtt-implementation-detail.md, issue #13).
 *
 *               Replaces the old pattern of opening a brand-new `net.Socket`
 *               for every single command (in iTachControllers.js/tcpServers.js)
 *               with ONE long-lived connection per host:port, kept in a
 *               module-level map (see getConnection()). This matters because
 *               iTach controllers only accept a single TCP client per port --
 *               two commands fired in quick succession under the old code
 *               could open colliding sockets and race each other.
 *
 *               Public surface:
 *                 getConnection(host, port, opts) -> DeviceConnection
 *                 class DeviceConnection {
 *                   send(cmd, {expectResponse, timeoutMs}) -> Promise<string|null>
 *                   onStatusChange(cb)   // cb('online' | 'offline')
 *                 }
 *
 *               DeviceConnection NEVER publishes to MQTT itself -- callers
 *               (iTachControllers.js, tcpServers.js) own topic construction via
 *               mqttTopics.js, per that module's own doc comment ("drivers
 *               never concatenate topic strings"). This module only reports
 *               connectivity via onStatusChange().
 *
 *               send() NEVER rejects. Every failure mode (write error, response
 *               timeout, stale-queue drop, connect failure) resolves the
 *               returned promise with `null` instead -- callers that forget to
 *               .catch() can never produce an unhandled rejection, which
 *               matters because some commands (e.g. IR "fire-and-forget" sends)
 *               are launched without being awaited.
 */

const net = require('net');

// --- Defaults (all overridable per-connection via getConnection(...,opts)) ---
const DEFAULT_SPACING_MS = 500;           // inter-command spacing (replaces the old 500ms setTimeout chains)
const DEFAULT_RESPONSE_TIMEOUT_MS = 3000; // response framing timeout when expectResponse is set
const DEFAULT_CONNECT_TIMEOUT_MS = 5000;  // bound a hung TCP handshake
const DEFAULT_STALE_MS = 30000;           // a queued command older than this is dropped, not sent
const DEFAULT_BACKOFF_INITIAL_MS = 1000;  // reconnect backoff floor
const DEFAULT_BACKOFF_MAX_MS = 30000;     // reconnect backoff ceiling
const DEFAULT_KEEPALIVE_MS = 30000;       // TCP-level keepalive probe interval on idle sockets
const MAX_PUMP_WAIT_MS = 250;             // poll-loop fallback cap while offline (bounded; real wakeups are event-driven)

/**
 * One persistent TCP connection to a single device (host:port). Lazily
 * connects on the first send(); serializes all commands through a FIFO queue
 * (one in-flight command at a time); reconnects with capped backoff while
 * there is unfinished work (a queued command or a status listener) to justify
 * it; and otherwise just stays open, idle, until the caller sends again.
 */
class DeviceConnection {
    constructor({
        host,
        port,
        name,
        spacingMs = DEFAULT_SPACING_MS,
        responseTimeoutMs = DEFAULT_RESPONSE_TIMEOUT_MS,
        connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
        staleMs = DEFAULT_STALE_MS,
        backoffInitialMs = DEFAULT_BACKOFF_INITIAL_MS,
        backoffMaxMs = DEFAULT_BACKOFF_MAX_MS,
        keepAliveMs = DEFAULT_KEEPALIVE_MS,
    }) {
        this.host = host;
        this.port = port;
        this.name = name || `${host}:${port}`;

        this.spacingMs = spacingMs;
        this.responseTimeoutMs = responseTimeoutMs;
        this.connectTimeoutMs = connectTimeoutMs;
        this.staleMs = staleMs;
        this.backoffInitialMs = backoffInitialMs;
        this.backoffMaxMs = backoffMaxMs;
        this.keepAliveMs = keepAliveMs;

        this.socket = null;
        this.status = 'offline'; // 'online' | 'offline'
        this.connecting = false;
        this.backoffMs = backoffInitialMs;
        this.reconnectTimer = null;

        this.queue = [];       // { cmd, expectResponse, timeoutMs, resolve, queuedAt }
        this.pumping = false;
        this._wakeResolvers = [];

        // Resolver for whatever command is currently "in flight" (written,
        // awaiting a response) -- lets a socket close/error resolve it
        // immediately instead of leaving it hanging.
        this._activeFinish = null;

        this.statusListeners = [];
    }

    /**
     * Registers a callback invoked with 'online' or 'offline' on every status
     * TRANSITION (not a repeat of the current state). Callers own what they do
     * with it (publish a status topic, mark unreachable, etc).
     * @param {function(string): void} cb
     */
    onStatusChange(cb) {
        this.statusListeners.push(cb);
    }

    /**
     * Enqueues a command. Resolves with the framed response string (when
     * expectResponse is true and a response arrives before timeoutMs), or
     * `null` in every other case (fire-and-forget, timeout, write error,
     * connection lost mid-command, or the command went stale in queue before
     * it could be sent). Never rejects.
     * @param {string} cmd
     * @param {{expectResponse?: boolean, timeoutMs?: number}} [opts]
     * @returns {Promise<string|null>}
     */
    send(cmd, opts = {}) {
        const { expectResponse = false, timeoutMs } = opts;
        return new Promise((resolve) => {
            this.queue.push({
                cmd,
                expectResponse,
                timeoutMs: timeoutMs || this.responseTimeoutMs,
                resolve,
                queuedAt: Date.now(),
            });
            this._pump();
        });
    }

    _setStatus(next) {
        if (this.status === next) {
            return;
        }
        this.status = next;
        if (next === 'online') {
            this._wake();
        }
        for (const cb of this.statusListeners) {
            try {
                cb(next);
            } catch (err) {
                console.log('DeviceConnection %s: status listener threw: %s', this.name, err.message);
            }
        }
    }

    _wake() {
        const resolvers = this._wakeResolvers;
        this._wakeResolvers = [];
        for (const resolve of resolvers) {
            resolve();
        }
    }

    _waitForWakeOrTimeout(maxMs) {
        return new Promise((resolve) => {
            let done = false;
            const finish = () => {
                if (done) {
                    return;
                }
                done = true;
                clearTimeout(timer);
                resolve();
            };
            // Deliberately NOT unref'd: this timer is how the pump loop notices a
            // queued command has gone stale and resolves its promise. Unref'ing it
            // would let a process whose event loop is otherwise idle exit before
            // that resolution ever happens, breaking the "send() always eventually
            // settles" guarantee.
            const timer = setTimeout(finish, Math.max(0, maxMs));
            this._wakeResolvers.push(finish);
        });
    }

    /**
     * Lazily starts a connection attempt if one isn't already in flight and no
     * backoff-scheduled reconnect is pending (that pending timer owns the next
     * attempt -- calling this here would race it and defeat the backoff).
     */
    _ensureSocket() {
        if (this.socket || this.connecting || this.reconnectTimer) {
            return;
        }
        this.connecting = true;

        // Not unref'd: a caller may be actively awaiting a command over this
        // connection, and a hung connect needs to reliably time out and resolve
        // that promise rather than risk the process exiting first. In production
        // Apollo always has other ref'd handles open (webServer, mqttClient) so
        // this never affects real shutdown; it only matters for bare/isolated
        // processes (e.g. these tests), where correctness beats being unref'd.
        const socket = new net.Socket();
        socket.setKeepAlive(true, this.keepAliveMs);
        this.socket = socket;

        const connectTimer = setTimeout(() => {
            console.log('DeviceConnection %s: connect timed out after %dms', this.name, this.connectTimeoutMs);
            socket.destroy();
        }, this.connectTimeoutMs);

        socket.connect(this.port, this.host, () => {
            clearTimeout(connectTimer);
            this.connecting = false;
            this.backoffMs = this.backoffInitialMs;
            console.log('DeviceConnection %s: connected', this.name);
            this._setStatus('online');
            this._pump();
        });

        socket.on('data', (data) => this._onData(data));

        const onDown = () => {
            clearTimeout(connectTimer);
            this.connecting = false;
            if (this.socket === socket) {
                this.socket = null;
            }
            this._setStatus('offline');
            if (this._activeFinish) {
                const finish = this._activeFinish;
                this._activeFinish = null;
                finish(null);
            }
            this._maybeScheduleReconnect();
            this._wake();
        };

        socket.on('error', (err) => {
            console.log('DeviceConnection %s: %s', this.name, err.message);
            onDown();
        });

        socket.on('close', () => {
            console.log('DeviceConnection %s: connection closed', this.name);
            onDown();
        });
    }

    _onData(data) {
        if (this._activeDataHandler) {
            this._activeDataHandler(data);
        }
    }

    /**
     * Schedules the next reconnect attempt with capped exponential backoff,
     * but ONLY if there is still a reason to reconnect (a queued command, or a
     * status consumer who cares about connectivity). Otherwise the connection
     * just stays idle/closed until the next send() lazily reconnects.
     */
    _maybeScheduleReconnect() {
        if (this.reconnectTimer) {
            return;
        }
        const shouldReconnect = this.queue.length > 0 || this.statusListeners.length > 0;
        if (!shouldReconnect) {
            return;
        }
        const delay = this.backoffMs;
        this.backoffMs = Math.min(this.backoffMs * 2, this.backoffMaxMs);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this._ensureSocket();
        }, delay);
        // Unref'd deliberately: this is a best-effort background retry, not
        // something a caller is blocked on directly. If it's the only thing left
        // pending (empty queue, only a status listener), letting the process exit
        // rather than holding it open indefinitely is correct. Any queued command
        // is independently guaranteed to resolve via the pump loop's own (ref'd)
        // stale-check watchdog in _pump()/_waitForWakeOrTimeout, so unref'ing this
        // timer never breaks the "send() always eventually settles" guarantee.
        this.reconnectTimer.unref();
    }

    /**
     * The queue-draining loop. Only one instance of this ever runs at a time
     * per connection (guarded by `pumping`); re-entrant calls just return.
     */
    async _pump() {
        if (this.pumping) {
            return;
        }
        this.pumping = true;
        try {
            while (this.queue.length > 0) {
                const item = this.queue[0];

                if (Date.now() - item.queuedAt > this.staleMs) {
                    this.queue.shift();
                    console.log(
                        'DeviceConnection %s: dropping stale command "%s" (queued %dms ago, never sent)',
                        this.name, item.cmd, Date.now() - item.queuedAt
                    );
                    item.resolve(null);
                    continue;
                }

                if (this.status !== 'online') {
                    this._ensureSocket();
                    const msUntilStale = item.queuedAt + this.staleMs - Date.now();
                    await this._waitForWakeOrTimeout(Math.max(20, Math.min(msUntilStale, MAX_PUMP_WAIT_MS)));
                    continue;
                }

                this.queue.shift();
                const result = await this._sendOne(item);
                item.resolve(result);

                if (this.queue.length > 0) {
                    await delay(this.spacingMs);
                }
            }
        } finally {
            this.pumping = false;
        }
    }

    /**
     * Writes a single command to the (already-connected) socket and resolves
     * once we know the outcome: the framed response (expectResponse, response
     * arrived before timeoutMs), or null (fire-and-forget resolves right after
     * write; timeout; write error; or the socket went down while we waited).
     * @param {{cmd: string, expectResponse: boolean, timeoutMs: number}} item
     * @returns {Promise<string|null>}
     */
    _sendOne(item) {
        return new Promise((resolve) => {
            const socket = this.socket;
            if (!socket) {
                resolve(null);
                return;
            }

            let settled = false;
            let buffer = '';
            let timer = null;

            const finish = (result) => {
                if (settled) {
                    return;
                }
                settled = true;
                if (timer) {
                    clearTimeout(timer);
                }
                this._activeDataHandler = null;
                if (this._activeFinish === finish) {
                    this._activeFinish = null;
                }
                resolve(result);
            };

            if (item.expectResponse) {
                this._activeDataHandler = (chunk) => {
                    buffer += chunk.toString();
                    const idx = buffer.indexOf('\r');
                    if (idx !== -1) {
                        finish(buffer.slice(0, idx));
                    }
                };
                this._activeFinish = finish;
                // Not unref'd -- this is the timer that bounds and resolves the
                // promise send() returned to the caller for THIS command; it must
                // fire even if it's the only thing keeping an otherwise-idle
                // process's event loop alive.
                timer = setTimeout(() => {
                    console.log('DeviceConnection %s: response timeout for command "%s"', this.name, item.cmd);
                    finish(null);
                }, item.timeoutMs);
            }

            try {
                socket.write(item.cmd, (err) => {
                    if (err) {
                        console.log('DeviceConnection %s: write error: %s', this.name, err.message);
                        finish(null);
                        return;
                    }
                    if (!item.expectResponse) {
                        finish(null);
                    }
                });
            } catch (err) {
                console.log('DeviceConnection %s: write threw: %s', this.name, err.message);
                finish(null);
            }
        });
    }

    /**
     * Tears down the connection immediately: clears timers, resolves any
     * queued/in-flight commands with null, drops status listeners, and
     * destroys the socket. Test-only in practice (production connections are
     * meant to live for the lifetime of the process) but safe to call anytime.
     */
    destroy() {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this._activeFinish) {
            const finish = this._activeFinish;
            this._activeFinish = null;
            finish(null);
        }
        for (const item of this.queue) {
            item.resolve(null);
        }
        this.queue = [];
        this.statusListeners = [];
        if (this.socket) {
            this.socket.removeAllListeners();
            this.socket.destroy();
            this.socket = null;
        }
        this.status = 'offline';
        this._wake();
    }
}

function delay(ms) {
    // Not unref'd -- used for the inter-command spacing pause between queued
    // sends; it must fire to let the pump loop keep draining the queue and
    // resolving the promises callers are holding.
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

// --- Module-level connection registry: one DeviceConnection per host:port ---
const connections = new Map();

function keyFor(host, port) {
    return `${host}:${port}`;
}

/**
 * Returns the shared DeviceConnection for a host:port, creating it (with
 * `opts`) on first use. Subsequent calls for the same host:port return the
 * SAME instance -- `opts` are only honored the first time.
 * @param {string} host
 * @param {number|string} port
 * @param {object} [opts] - passed to the DeviceConnection constructor on first creation
 * @returns {DeviceConnection}
 */
function getConnection(host, port, opts = {}) {
    const key = keyFor(host, port);
    let conn = connections.get(key);
    if (!conn) {
        conn = new DeviceConnection({ host, port, ...opts });
        connections.set(key, conn);
    }
    return conn;
}

/**
 * Test-only: destroys every live connection and clears the registry so tests
 * don't leak sockets/timers into each other or leave the test process hanging.
 */
function _resetAll() {
    for (const conn of connections.values()) {
        conn.destroy();
    }
    connections.clear();
}

module.exports = {
    DeviceConnection,
    getConnection,
    _resetAll,
};
