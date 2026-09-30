/**
 * Unit tests for src/systemApps.js: pure parsers plus collectApps()/getApps()
 * with injected fetch/fs/execFile fakes (no network, no Pi).
 */

const assert = require('node:assert');
const { test, beforeEach } = require('node:test');

const apps = require('../src/systemApps');

beforeEach(() => apps.resetForTests());

const KUMA = [
    '# HELP monitor_status Monitor Status',
    'monitor_status{monitor_type="http",monitor_name="Apollo (API)",monitor_url="http://x",monitor_hostname="null",monitor_port="null"} 1',
    'monitor_status{monitor_type="ping",monitor_name="Hue — Bridge, main",monitor_url="https://",monitor_hostname="h",monitor_port="null"} 0',
    'monitor_status{monitor_type="http",monitor_name="Say \\"hi\\" {x}",monitor_url="https://",monitor_hostname="null",monitor_port="null"} 1',
    'monitor_status{monitor_type="ping",monitor_name="Synology NAS",monitor_url="https://",monitor_hostname="h",monitor_port="null"} 1',
    'monitor_response_time{monitor_name="Apollo (API)"} 12',
].join('\n');

test('parseKumaMetrics: counts, down names, odd names', () => {
    const k = apps.parseKumaMetrics(KUMA);
    assert.strictEqual(k.total, 4);
    assert.strictEqual(k.up, 3);
    assert.deepStrictEqual(k.down, ['Hue — Bridge, main']);
    assert.ok(k.monitors.some(m => m.name === 'Say "hi" {x}'));
    assert.ok(k.monitors.some(m => m.name === 'Apollo (API)'));
});

test('parseKumaMetrics: pending/maintenance are neither up nor down', () => {
    const k = apps.parseKumaMetrics('monitor_status{monitor_name="a"} 2\nmonitor_status{monitor_name="b"} 3');
    assert.deepStrictEqual([k.up, k.total, k.down.length], [0, 2, 0]);
});

const run = (job, finished, result, extra) => JSON.stringify(Object.assign({ job, finished, result, data_added: 5 }, extra));

test('parseRunsTail: drops partial first line and malformed lines; sorts by finished', () => {
    const text = [
        '{"job":"cut off","finished":"2026-09-01T00:00:0',
        run('b.awsw', '2026-09-29T04:49:21-04:00', 'ok'),
        'garbage',
        run('a.awsw', '2026-09-28T04:49:21-04:00', 'ok'),
    ].join('\n');
    const runs = apps.parseRunsTail(text, true);
    assert.deepStrictEqual(runs.map(r => r.job), ['a.awsw', 'b.awsw']);
    assert.strictEqual(runs[1].finished, Math.floor(Date.parse('2026-09-29T04:49:21-04:00') / 1000));
    // Without partialFirst the first (valid) line is kept.
    assert.strictEqual(apps.parseRunsTail(run('z.awsw', '2026-09-01T00:00:00Z', 'ok') + '\n', false).length, 1);
});

test('summarizeRuns: failing latest vs recovered job, last run, synology', () => {
    const runs = apps.parseRunsTail([
        run('pictures.awsc', '2026-09-27T01:00:00Z', 'failed'),
        run('pictures.awsc', '2026-09-28T01:00:00Z', 'ok'),      // recovered
        run('Movies.syn8', '2026-09-28T02:00:00Z', 'ok'),
        run('Movies.syn8', '2026-09-29T02:00:00Z', 'failed'),    // failing latest
        run('personal.awsc', '2026-09-29T03:00:00Z', 'ok', { data_added: 42 }),
    ].join('\n'), false);
    const s = apps.summarizeRuns(runs);
    assert.deepStrictEqual(s.failingJobs, [{ job: 'Movies', finished: Math.floor(Date.parse('2026-09-29T02:00:00Z') / 1000) }]);
    assert.strictEqual(s.lastRun.job, 'personal');
    assert.strictEqual(s.lastRun.dataAdded, 42);
    assert.strictEqual(s.lastSuccessAt, Math.floor(Date.parse('2026-09-29T03:00:00Z') / 1000));
    assert.strictEqual(s.synology.lastBackupResult, 'failed');
});

test('summarizeUps: status flags and numbers', () => {
    const u = apps.summarizeUps({ 'ups.status': 'OL CHRG LB', 'battery.charge': 14, 'battery.runtime': 451, 'device.model': 'CP 1500C', 'ups.load': 9 });
    assert.deepStrictEqual([u.onBattery, u.lowBattery, u.charging], [false, true, true]);
    assert.deepStrictEqual([u.batteryPct, u.runtimeSeconds, u.loadPct, u.model], [14, 451, 9, 'CP 1500C']);
    const b = apps.summarizeUps({ 'ups.status': 'OB DISCHRG' });
    assert.deepStrictEqual([b.onBattery, b.lowBattery, b.charging], [true, false, false]);
    assert.throws(() => apps.summarizeUps(undefined));
});

test('summarizeHost: cpuAvg is the mean of cores, throttle camelCased', () => {
    const h = apps.summarizeHost({
        hostname: 'pi', unix: 100, uptime_seconds: 5, load: [1, 2, 3],
        cores: { cpu0: 0.6, cpu1: 1.0, cpu2: 0.4, cpu3: 1.6 }, soc_temp_c: 55.1,
        throttle: { throttled_now: true }, root_disk: { free_bytes: 1, total_bytes: 2 },
    });
    assert.strictEqual(h.cpuAvg, 0.9);
    assert.strictEqual(h.throttle.throttledNow, true);
    assert.strictEqual(h.throttle.underVoltageNow, false);
    assert.strictEqual(h.updated, 100);
    assert.strictEqual(h.diskTotalBytes, 2);
});

test('parseRunning / nextResticRun', () => {
    assert.deepStrictEqual(apps.parseRunning([
        { job: 'piconf.awsw', state: 'running', percent_done: 63.6 },
        { job: 'x.offw', state: 'scanning' },
        { job: 'dead.offw', state: 'interrupted' },
        null,
    ]), [{ job: 'piconf', pct: 64 }, { job: 'x', pct: null }]);
    const host = { timers: [{ unit: 'restic-backup', next: 50 }, { unit: 'restic-x', next: 200 }, { unit: 'apt', next: 150 }, { unit: 'restic-y', next: 300 }] };
    assert.strictEqual(apps.nextResticRun(host, 100), 200);
    assert.strictEqual(apps.nextResticRun({ timers: [] }, 100), null);
});

// ---- integration with fakes ----

const HOST = {
    hostname: 'pi', unix: 1000, uptime_seconds: 1, load: [0, 0, 0], cores: { cpu0: 1, cpu1: 3 },
    soc_temp_c: 50, throttle: {}, root_disk: { free_bytes: 1, total_bytes: 2 },
    timers: [{ unit: 'restic-backup', next: 5000 }],
};
const RUNS = [run('personal.awsc', '2026-09-29T03:00:00Z', 'ok'), run('Movies.syn8', '2026-09-29T02:00:00Z', 'ok')].join('\n') + '\n';

function makeDeps(overrides) {
    const calls = { fetch: 0 };
    const res = (body, status) => ({ ok: (status || 200) < 400, status: status || 200, json: async () => body, text: async () => String(body) });
    const files = {
        '/run/restic-status/host.json': JSON.stringify(HOST),
        '/var/lib/restic-status/runs.jsonl': RUNS,
        '/run/restic-status/current/piconf.json': JSON.stringify({ job: 'piconf.awsw', state: 'running', percent_done: 10 }),
        '/var/lib/homebridge/node_modules/homebridge/package.json': '{"version":"2.1.0"}',
    };
    const deps = {
        env: {},
        now: () => 2000 * 1000,
        fetch: async (url) => {
            calls.fetch++;
            if (url.includes(':3001')) return res(KUMA);
            if (url.includes(':8080')) return res([{ 'ups.status': 'OL', 'battery.charge': 100 }]);
            if (url.includes('/System/Info/Public')) return res({ Version: '10.11.11', ServerName: 'pi' });
            return res('', 200);
        },
        fs: {
            readFile: async (p) => { if (p in files) return files[p]; throw new Error('ENOENT'); },
            readdir: async () => ['piconf.json', 'x.json.tmp'],
            open: async (p) => {
                if (!(p in files)) throw new Error('ENOENT');
                const buf = Buffer.from(files[p]);
                return { stat: async () => ({ size: buf.length }), read: async (b, o, l, pos) => { buf.copy(b, o, pos, pos + l); }, close: async () => {} };
            },
        },
        execFile: (cmd, args, opts, cb) => cb(null, 'active\n'),
    };
    Object.assign(deps, overrides);
    return { deps, calls };
}

test('collectApps: full happy path matches the contract shape', async () => {
    const { deps } = makeDeps();
    const out = await apps.collectApps(deps);
    assert.strictEqual(out.generatedAt, 2000);
    const a = out.apps;
    assert.strictEqual(a.host.cpuAvg, 2);
    assert.deepStrictEqual([a.kuma.up, a.kuma.total], [3, 4]);
    assert.deepStrictEqual(a.archive.running, [{ job: 'piconf', pct: 10 }]);
    assert.strictEqual(a.archive.nextRunAt, 5000);
    assert.strictEqual(a.archive.lastRun.job, 'personal');
    assert.deepStrictEqual(a.homebridge, { ok: true, running: true, version: '2.1.0' });
    assert.strictEqual(a.jellyfin.version, '10.11.11');
    assert.strictEqual(a.jellyfin.sessions, null);
    assert.deepStrictEqual([a.synology.reachable, a.synology.lastBackupResult], [true, 'ok']);
    assert.strictEqual(a.dmx.reachable, true);
    assert.strictEqual(a.labelmaker.reachable, true);
    assert.strictEqual(a.ups.ok, true);
});

test('collectApps: one failing source only affects its own app', async () => {
    const { deps } = makeDeps();
    const inner = deps.fetch;
    deps.fetch = async (url, o) => { if (url.includes(':8080')) throw new Error('connect ECONNREFUSED'); return inner(url, o); };
    const out = await apps.collectApps(deps);
    assert.strictEqual(out.apps.ups.ok, false);
    assert.match(out.apps.ups.error, /ECONNREFUSED/);
    assert.strictEqual(out.apps.kuma.ok, true);
    assert.strictEqual(out.apps.host.ok, true);
});

test('collectApps: missing host.json fails host but archive still works (nextRunAt null)', async () => {
    const { deps } = makeDeps();
    const inner = deps.fs.readFile;
    deps.fs.readFile = async (p) => { if (p.endsWith('host.json')) throw new Error('ENOENT'); return inner(p); };
    const out = await apps.collectApps(deps);
    assert.strictEqual(out.apps.host.ok, false);
    assert.strictEqual(out.apps.archive.ok, true);
    assert.strictEqual(out.apps.archive.nextRunAt, null);
});

test('collectApps: jellyfin sessions with API key; unreachable dmx is ok:true reachable:false', async () => {
    const { deps } = makeDeps({ env: { JELLYFIN_API_KEY: 'k' } });
    const inner = deps.fetch;
    deps.fetch = async (url, o) => {
        if (url.endsWith('/Sessions')) {
            assert.strictEqual(o.headers['X-Emby-Token'], 'k');
            return { ok: true, json: async () => [{ UserName: 'ray', DeviceName: 'TV', NowPlayingItem: { Name: 'Ep 1', SeriesName: 'Show' } }, { UserName: 'idle' }] };
        }
        if (url.includes('dmx.local')) throw new Error('ENOTFOUND');
        return inner(url, o);
    };
    const out = await apps.collectApps(deps);
    assert.deepStrictEqual(out.apps.jellyfin.sessions, [{ user: 'ray', title: 'Show - Ep 1', device: 'TV' }]);
    assert.deepStrictEqual(out.apps.dmx, { ok: true, reachable: false });
});

test('getApps: cache is reused and concurrent calls share one refresh', async () => {
    const { deps, calls } = makeDeps();
    const [a, b] = await Promise.all([apps.getApps(deps), apps.getApps(deps)]);
    assert.strictEqual(a, b);
    const afterFirst = calls.fetch;
    const c = await apps.getApps(deps);
    assert.strictEqual(c, a);
    assert.strictEqual(calls.fetch, afterFirst);
});

test('summarizeRuns: with a coverage policy, only required+enabled jobs can be failing', () => {
    const runs = [
        { job: 'TV Series.offc', finished: 100, result: 'failed', dataAdded: 0 },   // disabled in policy
        { job: 'TV Series.offw', finished: 200, result: 'ok', dataAdded: 1 },
        { job: 'Other.offc', finished: 300, result: 'failed', dataAdded: 0 },       // source "backup/Other"
        { job: 'pictures.awsc', finished: 400, result: 'partial', attempt: 1, dataAdded: 0 },  // retry pending
        { job: 'Retired.offw', finished: 500, result: 'failed', dataAdded: 0 },    // not in policy at all
    ];
    const coverage = { sources: [
        { id: 'TV Series', jobs: { offw: { required: true, enabled: true }, offc: { required: false, enabled: false } } },
        { id: 'backup/Other', jobs: { offc: { required: true, enabled: true } } },
        { id: 'pictures', jobs: { awsc: { required: true, enabled: true } } },
    ] };
    const s = apps.summarizeRuns(runs, coverage);
    assert.deepStrictEqual(s.failingJobs.map((f) => f.job), ['Other']);
});

test('summarizeRuns: a partial run on its second attempt counts as failing', () => {
    const s = apps.summarizeRuns([{ job: 'etc.awsw', finished: 1, result: 'partial', attempt: 2, dataAdded: 0 }], null);
    assert.strictEqual(s.failingJobs.length, 1);
});

test('kuma: APPS_KUMA_API_KEY is sent as basic auth with an empty username', async () => {
    const { deps } = makeDeps({ env: { APPS_KUMA_API_KEY: 'k123' } });
    const inner = deps.fetch;
    let seen = null;
    deps.fetch = async (url, o) => {
        if (url.includes(':3001')) seen = o && o.headers && o.headers.Authorization;
        return inner(url, o);
    };
    const out = await apps.collectApps(deps);
    assert.strictEqual(seen, 'Basic ' + Buffer.from(':k123').toString('base64'));
    assert.strictEqual(out.apps.kuma.ok, true);
});

test('kuma: no API key sends no Authorization header', async () => {
    const { deps } = makeDeps();
    const inner = deps.fetch;
    let headers = 'unset';
    deps.fetch = async (url, o) => {
        if (url.includes(':3001')) headers = o && o.headers;
        return inner(url, o);
    };
    await apps.collectApps(deps);
    assert.strictEqual(headers, undefined);
});
