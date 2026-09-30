/**
 * Unit tests for src/lightingCaseta.js. Fake LEAP client injected via _init;
 * no network, no index.js boot.
 */
const assert = require('node:assert');
const { test, beforeEach } = require('node:test');
const { EventEmitter } = require('node:events');

const caseta = require('../src/lightingCaseta');

let published, states, unreachable, timers, clients, handled, light, pico;

class FakeClient extends EventEmitter {
    constructor(opts = {}) {
        super();
        this.requests = [];
        this.subs = [];
        this.failConnect = opts.failConnect || false;
        this.closed = false;
    }
    async connect() { if (this.failConnect) { throw new Error('refused'); } }
    async request(type, url, body) {
        this.requests.push({ type, url, body });
        if (type === 'ReadRequest' && url.endsWith('/status') && url.startsWith('/zone/')) {
            return { Body: { ZoneStatus: { Zone: { href: url.replace('/status', '') }, Level: 40, Availability: 'Available' } } };
        }
        return { Header: { StatusCode: { isSuccessful: () => true, message: '200 OK' } } };
    }
    async subscribe(url, cb) { this.subs.push({ url, cb }); return { response: { Body: {} }, tag: 't' }; }
    close() { this.closed = true; }
    drain() { this.closed = true; this.removeAllListeners(); }
}

function setup(extra = {}) {
    caseta._reset();
    published = []; states = []; unreachable = []; timers = []; clients = []; handled = [];
    light = { id: 'bedroomMain', type: 'caseta', address: '/zone/1', room: 'master' };
    pico = [{ id: 'bedroomPico', buttons: [{ id: '/button/101', name: 'on' }, { id: '/button/105', name: 'lower' }], actions: {} }];
    caseta._init({
        lights: [light, { id: 'other', type: 'insteon', address: 'AA' }],
        pico,
        publish: (t, p, o) => published.push({ t, p, o }),
        publishState: (e, s, src) => states.push({ e, s, src }),
        publishUnreachable: (e) => unreachable.push(e),
        createClient: () => { const c = extra.makeClient ? extra.makeClient(clients.length) : new FakeClient(); clients.push(c); return c; },
        readPairing: extra.readPairing || (() => ({ host: 'h', key: 'k', cert: 'c', ca: 'a' })),
        setTimer: (fn, ms) => { const t = { fn, ms, unref() {} }; timers.push(t); return t; },
        clearTimer: () => {},
        handleRequest: (p) => handled.push(p),
    });
}

beforeEach(() => { delete process.env.APOLLO_DRY_RUN; setup(); });

const zs = (level, href = '/zone/1') => ({ Body: { ZoneStatus: { Zone: { href }, Level: level, Availability: 'Available' } } });

test('ZoneStatus publishes power+brightness and syncs entry', () => {
    caseta._onZoneResponse(zs(60));
    assert.deepStrictEqual(states[0].s, { power: 'ON', brightness: 60 });
    assert.strictEqual(states[0].src, 'event');
    assert.strictEqual(light.checked, true);
    assert.strictEqual(light.status, 60);
    caseta._onZoneResponse(zs(0));
    assert.deepStrictEqual(states[1].s, { power: 'OFF', brightness: 0 });
    assert.strictEqual(light.checked, false);
});

test('ZoneStatus for unconfigured zone is ignored; ZoneStatuses array handled', () => {
    caseta._onZoneResponse(zs(50, '/zone/9'));
    assert.strictEqual(states.length, 0);
    caseta._onZoneResponse({ Body: { ZoneStatuses: [zs(30).Body.ZoneStatus, zs(5, '/zone/9').Body.ZoneStatus] } });
    assert.strictEqual(states.length, 1);
    assert.strictEqual(states[0].s.brightness, 30);
});

test('connect: reads zone, subscribes zone + pico buttons, publishes online', async () => {
    caseta.startCasetaListener();
    await new Promise((r) => setImmediate(r));
    const c = clients[0];
    assert.ok(c.requests.some((r) => r.type === 'ReadRequest' && r.url === '/zone/1/status'));
    assert.deepStrictEqual(c.subs.map((s) => s.url), ['/zone/status', '/button/101/status/event', '/button/105/status/event']);
    assert.deepStrictEqual(published.find((p) => p.t === 'apollo/bridge/caseta/status'), { t: 'apollo/bridge/caseta/status', p: 'online', o: { qos: 1, retain: true } });
    assert.strictEqual(states[0].s.brightness, 40);
    assert.strictEqual(states[0].src, 'poll');
});

async function connected() {
    caseta.startCasetaListener();
    await new Promise((r) => setImmediate(r));
    return clients[0];
}

test('command: numeric level -> GoToLevel body/url and optimistic state', async () => {
    const c = await connected();
    states.length = 0;
    await caseta.caseta_command(1, '/zone/1', '35');
    const r = c.requests.find((x) => x.type === 'CreateRequest');
    assert.strictEqual(r.url, '/zone/1/commandprocessor');
    assert.deepStrictEqual(r.body, { Command: { CommandType: 'GoToLevel', Parameter: [{ Type: 'Level', Value: 35 }] } });
    assert.deepStrictEqual(states[0].s, { power: 'ON', brightness: 35 });
    assert.strictEqual(states[0].src, 'command');
});

test('command: OFF=0, ON restores last level, ON defaults to 100', async () => {
    const c = await connected(); // initial read set last level 40
    const level = () => c.requests.filter((x) => x.type === 'CreateRequest').pop().body.Command.Parameter[0].Value;
    await caseta.caseta_command(1, '/zone/1', 'OFF');
    assert.strictEqual(level(), 0);
    await caseta.caseta_command(2, '/zone/1', 'ON');
    assert.strictEqual(level(), 40);
    await caseta.caseta_command(3, '/zone/1', '0');
    assert.strictEqual(level(), 0);
    await caseta.caseta_command(4, '/zone/7', 'ON');
    assert.strictEqual(level(), 100);
});

test('command: unknown command ignored; clamps range', async () => {
    const c = await connected();
    await caseta.caseta_command(1, '/zone/1', 'bogus');
    assert.strictEqual(c.requests.filter((x) => x.type === 'CreateRequest').length, 0);
    await caseta.caseta_command(2, '/zone/1', '250');
    assert.strictEqual(c.requests.pop().body.Command.Parameter[0].Value, 100);
});

test('command dropped when not connected', async () => {
    await caseta.caseta_command(1, '/zone/1', 'ON');
    assert.strictEqual(clients.length, 0);
    assert.strictEqual(states.length, 0);
});

test('disconnect -> offline, unreachable, reconnect with capped exponential backoff', async () => {
    const c = await connected();
    timers.length = 0;
    c.emit('disconnected');
    assert.strictEqual(published.filter((p) => p.t.endsWith('/status')).pop().p, 'offline');
    assert.strictEqual(unreachable.length, 1);
    assert.strictEqual(timers[0].ms, 1000);
    assert.strictEqual(caseta._getState().connected, false);
});

test('failed connects back off 1s,2s,4s ... capped at 30s, then recover', async () => {
    setup({ makeClient: (n) => new FakeClient({ failConnect: n < 8 }) });
    caseta.startCasetaListener();
    const delays = [];
    for (let i = 0; i < 8; i++) {
        await new Promise((r) => setImmediate(r));
        const t = timers.shift();
        delays.push(t.ms);
        t.fn();
    }
    assert.deepStrictEqual(delays, [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(caseta._getState().connected, true);
    assert.strictEqual(caseta._getState().backoffMs, 1000);
    assert.strictEqual(published.filter((p) => p.t.endsWith('/status')).pop().p, 'online');
});

test('duplicate disconnect events schedule only one reconnect', async () => {
    const c = await connected();
    timers.length = 0;
    c.emit('disconnected');
    c.emit('disconnected');
    assert.strictEqual(timers.filter((t) => t.ms === 1000).length, 1);
});

test('pico event publishes non-retained MQTT and no action when unmapped', async () => {
    const c = await connected();
    published.length = 0;
    const cb = c.subs.find((s) => s.url === '/button/101/status/event').cb;
    cb({ Body: { ButtonStatus: { ButtonEvent: { EventType: 'Press' } } } });
    assert.strictEqual(published.length, 1);
    assert.strictEqual(published[0].t, 'apollo/home/caseta/bedroomPico/button');
    assert.strictEqual(published[0].p.button, 'on');
    assert.strictEqual(published[0].p.event, 'Press');
    assert.strictEqual(typeof published[0].p.timestamp, 'number');
    assert.strictEqual(published[0].o.retain, false);
    assert.deepStrictEqual(handled, []);
});

test('pico mapped action runs through handleRequest', async () => {
    pico[0].actions = { 'lower.LongHold': 'LIGHTS/bedroomMain/30' };
    const c = await connected();
    const cb = c.subs.find((s) => s.url === '/button/105/status/event').cb;
    cb({ Body: { ButtonStatus: { ButtonEvent: { EventType: 'Release' } } } });
    assert.deepStrictEqual(handled, []);
    cb({ Body: { ButtonStatus: { ButtonEvent: { EventType: 'LongHold' } } } });
    assert.deepStrictEqual(handled, ['/LIGHTS/bedroomMain/30']);
});

test('missing pairing file -> disabled, no throw, no client', () => {
    setup({ readPairing: () => null });
    caseta.startCasetaListener();
    assert.strictEqual(caseta._getState().disabled, true);
    assert.strictEqual(clients.length, 0);
});

test('DRY_RUN: never connects; commands only log', async () => {
    process.env.APOLLO_DRY_RUN = '1';
    caseta.startCasetaListener();
    assert.strictEqual(clients.length, 0);
    await caseta.caseta_command(1, '/zone/1', 'ON');
    assert.strictEqual(states.length, 0);
});
