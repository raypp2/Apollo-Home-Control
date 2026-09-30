/**
 * System "Apps" aggregator for GET /api/system/apps.
 *
 * Collects status from home-server tools that run on the same Raspberry Pi as
 * Apollo (host metrics, Uptime Kuma, restic archive, UPS via PeaNUT,
 * Homebridge, DMX bridge, Jellyfin, Synology, label maker) and returns one
 * JSON document for the dashboard's System Status screen.
 *
 * Each source runs independently with its own timeout; a failing source
 * yields { ok:false, error } for that app only. The whole aggregate is cached
 * for a few seconds and concurrent callers share one in-flight refresh, so
 * several open dashboards polling every 10s don't hammer the sources.
 *
 * Pure parsers (parseKumaMetrics, parseRunsTail, summarizeUps, summarizeHost,
 * ...) are exported for unit tests, and collectApps() takes an injectable
 * dependency object ({ fetch, fs, execFile, env, now }) so the whole thing is
 * testable without a Pi. This module deliberately does NOT require('../index')
 * so it can be loaded standalone.
 */

const fsPromises = require('node:fs/promises');
const { execFile } = require('node:child_process');

const SOURCE_TIMEOUT_MS = 2500;
const CACHE_TTL_MS = 8000;
const RUNS_TAIL_BYTES = 512 * 1024;

const DEFAULT_URLS = {
    APPS_KUMA_URL: 'http://127.0.0.1:3001/metrics',
    APPS_PEANUT_URL: 'http://127.0.0.1:8080/api/v1/devices',
    APPS_JELLYFIN_URL: 'http://127.0.0.1:8096',
    APPS_DMX_URL: 'http://dmx.local/',
    APPS_LABELMAKER_URL: 'http://127.0.0.1:8082/',
    APPS_HOST_JSON: '/run/restic-status/host.json',
    APPS_RUNS_JSONL: '/var/lib/restic-status/runs.jsonl',
    APPS_COVERAGE_JSON: '/var/lib/restic-status/coverage.json',
    APPS_RUNS_CURRENT_DIR: '/run/restic-status/current',
    APPS_HOMEBRIDGE_PKG: '/var/lib/homebridge/node_modules/homebridge/package.json',
};

/** Reads an env-overridable setting, falling back to its default. */
function setting(env, name) {
    return (env && env[name]) || DEFAULT_URLS[name];
}

// ---------------------------------------------------------------------------
// Pure parsers
// ---------------------------------------------------------------------------

/** Unescapes a Prometheus label value (\\, \", \n). */
function unescapeLabel(value) {
    return value.replace(/\\(.)/g, function(_, c) { return c === 'n' ? '\n' : c; });
}

/**
 * Parses Uptime Kuma's Prometheus text into monitor statuses. Only
 * `monitor_status{...} <n>` lines are read. Label values are quoted and may
 * contain spaces, commas, braces, em dashes, and escaped quotes.
 * @param {string} text
 * @returns {{up:number, total:number, down:string[], monitors:Array<{name:string,status:number}>}}
 */
function parseKumaMetrics(text) {
    const lineRe = /^monitor_status\{((?:[A-Za-z_]\w*="(?:[^"\\]|\\.)*",?)*)\}\s+(\S+)/;
    const labelRe = /([A-Za-z_]\w*)="((?:[^"\\]|\\.)*)"/g;
    const monitors = [];
    for (const line of String(text).split('\n')) {
        const m = lineRe.exec(line);
        if (!m) continue;
        const status = Number(m[2]);
        if (!Number.isFinite(status)) continue;
        const labels = {};
        let lm;
        labelRe.lastIndex = 0;
        while ((lm = labelRe.exec(m[1])) !== null) labels[lm[1]] = unescapeLabel(lm[2]);
        monitors.push({ name: labels.monitor_name || ('monitor ' + (labels.monitor_id || '?')), status });
    }
    return {
        up: monitors.filter(function(x) { return x.status === 1; }).length,
        total: monitors.length,
        down: monitors.filter(function(x) { return x.status === 0; }).map(function(x) { return x.name; }),
        monitors,
    };
}

/** Strips the trailing ".awsw"-style strategy suffix from a restic job name. */
function jobLabel(job) {
    const m = /^(.+)\.[A-Za-z0-9]{1,6}$/.exec(job);
    // Dot-directory sources (".ssh.awsw") read better without the dot.
    return (m ? m[1] : job).replace(/^\.+(?=.)/, '');
}

/**
 * Parses the tail of runs.jsonl. When `partialFirst` is true the first line is
 * dropped (the read began mid-line). Malformed lines are skipped.
 * @param {string} text
 * @param {boolean} [partialFirst]
 * @returns {Array<{job:string, finished:number, result:string, dataAdded:number|null}>} sorted oldest to newest
 */
function parseRunsTail(text, partialFirst) {
    let lines = String(text).split('\n');
    if (partialFirst) lines = lines.slice(1);
    const runs = [];
    for (const line of lines) {
        if (!line.trim()) continue;
        let o;
        try { o = JSON.parse(line); } catch (e) { continue; }
        if (!o || typeof o.job !== 'string') continue;
        const finished = Date.parse(o.finished);
        if (!Number.isFinite(finished)) continue;
        runs.push({
            job: o.job,
            finished: Math.floor(finished / 1000),
            result: o.result,
            dataAdded: typeof o.data_added === 'number' ? o.data_added : null,
            attempt: typeof o.attempt === 'number' ? o.attempt : null,
        });
    }
    runs.sort(function(a, b) { return a.finished - b.finished; });
    return runs;
}

/**
 * Summarizes parsed runs: last run, last success, jobs whose most recent run
 * is not ok, and the most recent Synology (job name contains "synology" or
 * "syn8") run.
 * @param {Array} runs sorted oldest to newest (parseRunsTail output)
 */
/**
 * The job ids the backup policy (coverage.json, the same file the Archive
 * status page judges by) currently expects: every source+strategy that is
 * both `required` and `enabled`. Ids are `<source id>.<strategy>`; a source
 * id with a folder prefix (e.g. "backup/Other") also matches by its last
 * segment, which is how the wrapper names those jobs in runs.jsonl.
 * @param {object|null} coverage - parsed coverage.json
 * @returns {Set<string>|null} null when there's no usable policy
 */
function activeJobIds(coverage) {
    if (!coverage || !Array.isArray(coverage.sources)) return null;
    const ids = new Set();
    for (const src of coverage.sources) {
        if (!src || !src.id || !src.jobs) continue;
        const base = String(src.id).split('/').pop();
        for (const [strat, decl] of Object.entries(src.jobs)) {
            if (decl && decl.required && decl.enabled) {
                ids.add(`${src.id}.${strat}`);
                ids.add(`${base}.${strat}`);
            }
        }
    }
    return ids;
}

/**
 * Whether a run's result means that job needs attention. A `partial` run with
 * a retry still pending (first attempt) is being handled, like the status page.
 */
function isFailingRun(r) {
    if (r.result === 'ok') return false;
    if (r.result === 'partial' && !(r.attempt >= 2)) return false;
    return true;
}

function summarizeRuns(runs, coverage) {
    const active = activeJobIds(coverage);
    const latestByJob = new Map();
    let lastSuccessAt = null;
    let synology = null;
    for (const r of runs) {
        latestByJob.set(r.job, r);
        if (r.result === 'ok') lastSuccessAt = r.finished;
        if (/synology|syn8/i.test(r.job)) synology = r;
    }
    const last = runs.length ? runs[runs.length - 1] : null;
    const failingJobs = [];
    for (const r of latestByJob.values()) {
        // Only jobs the policy still expects: retired or disabled source+
        // strategy combos keep their last (failed) run in runs.jsonl forever.
        if (active && !active.has(r.job)) continue;
        if (isFailingRun(r)) failingJobs.push({ job: jobLabel(r.job), finished: r.finished });
    }
    return {
        lastRun: last && { job: jobLabel(last.job), finished: last.finished, result: last.result, dataAdded: last.dataAdded },
        lastSuccessAt,
        failingJobs,
        synology: synology && { lastBackupAt: synology.finished, lastBackupResult: synology.result },
    };
}

/**
 * Maps the parsed JSON files from /run/restic-status/current/ to running jobs.
 * Fields (from the status page script): job, state ("running"|"scanning"|
 * "interrupted"), percent_done (0-100).
 * @param {Array<object|null>} files
 * @returns {Array<{job:string, pct:number|null}>}
 */
function parseRunning(files) {
    const out = [];
    for (const c of files) {
        if (!c || !c.job) continue;
        if (c.state !== 'running' && c.state !== 'scanning') continue;
        const pct = typeof c.percent_done === 'number' && Number.isFinite(c.percent_done)
            ? Math.max(0, Math.min(100, Math.round(c.percent_done))) : null;
        out.push({ job: jobLabel(c.job), pct });
    }
    return out;
}

/**
 * Earliest future `next` among host.json timers whose unit starts with "restic".
 * @returns {number|null} unix seconds
 */
function nextResticRun(host, nowSec) {
    const times = ((host && host.timers) || [])
        .filter(function(t) { return t && typeof t.unit === 'string' && t.unit.startsWith('restic') && typeof t.next === 'number' && t.next > nowSec; })
        .map(function(t) { return t.next; });
    return times.length ? Math.min.apply(null, times) : null;
}

/** Shapes host.json into the contract's host object. */
function summarizeHost(h) {
    if (!h || typeof h !== 'object') throw new Error('bad host.json');
    const cores = h.cores || {};
    const vals = Object.values(cores).filter(function(v) { return typeof v === 'number'; });
    const cpuAvg = vals.length ? Math.round(vals.reduce(function(a, b) { return a + b; }, 0) / vals.length * 10) / 10 : null;
    const t = h.throttle || {};
    const d = h.root_disk || {};
    return {
        ok: true,
        hostname: h.hostname,
        updated: h.unix,
        uptimeSeconds: h.uptime_seconds,
        load: h.load,
        cores,
        cpuAvg,
        socTempC: h.soc_temp_c,
        throttle: {
            throttledNow: !!t.throttled_now,
            throttledSinceBoot: !!t.throttled_since_boot,
            underVoltageNow: !!t.under_voltage_now,
            underVoltageSinceBoot: !!t.under_voltage_since_boot,
        },
        diskFreeBytes: d.free_bytes,
        diskTotalBytes: d.total_bytes,
    };
}

/** Shapes a PeaNUT/NUT device var object into the contract's ups object. */
function summarizeUps(dev) {
    if (!dev || typeof dev !== 'object') throw new Error('no UPS device');
    const status = String(dev['ups.status'] || '');
    const flags = status.split(/\s+/);
    return {
        ok: true,
        model: dev['device.model'] || null,
        status,
        onBattery: flags.includes('OB'),
        lowBattery: flags.includes('LB'),
        charging: flags.includes('CHRG'),
        batteryPct: dev['battery.charge'] === undefined ? null : Number(dev['battery.charge']),
        runtimeSeconds: dev['battery.runtime'] === undefined ? null : Number(dev['battery.runtime']),
        loadPct: dev['ups.load'] === undefined ? null : Number(dev['ups.load']),
    };
}

/** Shapes Jellyfin /Sessions into the contract's session list (playing only). */
function summarizeJellyfinSessions(sessions) {
    return (Array.isArray(sessions) ? sessions : [])
        .filter(function(s) { return s && s.NowPlayingItem; })
        .map(function(s) {
            const item = s.NowPlayingItem;
            return {
                user: s.UserName || null,
                title: item.SeriesName ? item.SeriesName + ' - ' + item.Name : item.Name,
                device: s.DeviceName || null,
            };
        });
}

// ---------------------------------------------------------------------------
// I/O layer
// ---------------------------------------------------------------------------

function defaultDeps() {
    return {
        fetch: function(url, opts) { return fetch(url, opts); },
        fs: fsPromises,
        execFile,
        env: process.env,
        now: function() { return Date.now(); },
    };
}

async function fetchOk(deps, url, opts) {
    const res = await deps.fetch(url, Object.assign({ signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS) }, opts));
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res;
}

/** Reads only the last RUNS_TAIL_BYTES of a file; reports whether it began mid-line. */
async function readTail(deps, file) {
    const fh = await deps.fs.open(file, 'r');
    try {
        const { size } = await fh.stat();
        const start = Math.max(0, size - RUNS_TAIL_BYTES);
        const buf = Buffer.alloc(size - start);
        await fh.read(buf, 0, buf.length, start);
        return { text: buf.toString('utf8'), partialFirst: start > 0 };
    } finally {
        await fh.close();
    }
}

function withTimeout(promise, ms) {
    let timer;
    const timeout = new Promise(function(_, reject) {
        timer = setTimeout(function() { reject(new Error('timeout')); }, ms);
    });
    return Promise.race([promise, timeout]).finally(function() { clearTimeout(timer); });
}

// One log line per outage per source (state persists across refreshes).
const failing = new Set();
function noteHealth(name, ok, reason) {
    if (ok) {
        if (failing.delete(name)) console.log('systemApps: ' + name + ' recovered');
    } else if (!failing.has(name)) {
        failing.add(name);
        console.log('systemApps: ' + name + ' unavailable: ' + reason);
    }
}

/**
 * Collects the full aggregate (uncached).
 * @param {object} [deps] injectable { fetch, fs, execFile, env, now }
 * @returns {Promise<{generatedAt:number, apps:object}>}
 */
async function collectApps(deps) {
    deps = Object.assign(defaultDeps(), deps || {});
    const env = deps.env || {};
    const nowSec = Math.floor(deps.now() / 1000);

    // Shared upstream reads (each memoized so dependents reuse one fetch).
    const hostRaw = withTimeout((async function() {
        return JSON.parse(await deps.fs.readFile(setting(env, 'APPS_HOST_JSON'), 'utf8'));
    })(), SOURCE_TIMEOUT_MS);
    const kumaRaw = withTimeout((async function() {
        // Uptime Kuma API keys authenticate /metrics as HTTP basic auth with an
        // empty username and the key as the password.
        const headers = env.APPS_KUMA_API_KEY
            ? { Authorization: 'Basic ' + Buffer.from(':' + env.APPS_KUMA_API_KEY).toString('base64') }
            : undefined;
        const res = await fetchOk(deps, setting(env, 'APPS_KUMA_URL'), headers ? { headers } : undefined);
        return parseKumaMetrics(await res.text());
    })(), SOURCE_TIMEOUT_MS);
    const runsRaw = withTimeout((async function() {
        const t = await readTail(deps, setting(env, 'APPS_RUNS_JSONL'));
        let coverage = null;
        try {
            coverage = JSON.parse(await deps.fs.readFile(setting(env, 'APPS_COVERAGE_JSON'), 'utf8'));
        } catch (e) {
            // No policy file: fall back to judging every job's latest run.
        }
        return summarizeRuns(parseRunsTail(t.text, t.partialFirst), coverage);
    })(), SOURCE_TIMEOUT_MS);
    // Prevent unhandled rejections if a dependent never awaits them.
    [hostRaw, kumaRaw, runsRaw].forEach(function(p) { p.catch(function() {}); });

    const reachable = async function(url) {
        try {
            await deps.fetch(url, { signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS) });
            return { ok: true, reachable: true };
        } catch (e) {
            return { ok: true, reachable: false, reason: e.message };
        }
    };

    const sources = {
        host: async function() { return summarizeHost(await hostRaw); },
        kuma: async function() {
            const k = await kumaRaw;
            return { ok: true, up: k.up, total: k.total, down: k.down };
        },
        archive: async function() {
            const r = await runsRaw;
            let running = [];
            try {
                const dir = setting(env, 'APPS_RUNS_CURRENT_DIR');
                const names = (await deps.fs.readdir(dir)).filter(function(n) { return /\.json$/.test(n); });
                const files = await Promise.all(names.map(async function(n) {
                    try { return JSON.parse(await deps.fs.readFile(dir + '/' + n, 'utf8')); } catch (e) { return null; }
                }));
                running = parseRunning(files);
            } catch (e) { /* no current dir => nothing running */ }
            let nextRunAt = null;
            try { nextRunAt = nextResticRun(await hostRaw, nowSec); } catch (e) { /* host unavailable */ }
            return {
                ok: true, lastRun: r.lastRun, lastSuccessAt: r.lastSuccessAt,
                failingJobs: r.failingJobs, running, nextRunAt,
            };
        },
        ups: async function() {
            const res = await fetchOk(deps, setting(env, 'APPS_PEANUT_URL'));
            const list = await res.json();
            return summarizeUps(Array.isArray(list) ? list[0] : list);
        },
        homebridge: async function() {
            const out = await new Promise(function(resolve, reject) {
                deps.execFile('systemctl', ['is-active', 'homebridge'], { timeout: 3000 }, function(err, stdout) {
                    // is-active exits non-zero when inactive but still prints the state.
                    if (err && !stdout) reject(err); else resolve(String(stdout).trim());
                });
            });
            let version = null;
            try {
                version = JSON.parse(await deps.fs.readFile(setting(env, 'APPS_HOMEBRIDGE_PKG'), 'utf8')).version || null;
            } catch (e) { /* version unknown */ }
            return { ok: true, running: out === 'active', version };
        },
        dmx: async function() { return reachable(setting(env, 'APPS_DMX_URL')); },
        jellyfin: async function() {
            const base = setting(env, 'APPS_JELLYFIN_URL').replace(/\/+$/, '');
            let info;
            try {
                info = await (await fetchOk(deps, base + '/System/Info/Public')).json();
            } catch (e) {
                return { ok: true, reachable: false, version: null, serverName: null, sessions: null, reason: e.message };
            }
            let sessions = null;
            if (env.JELLYFIN_API_KEY) {
                try {
                    const res = await fetchOk(deps, base + '/Sessions', { headers: { 'X-Emby-Token': env.JELLYFIN_API_KEY } });
                    sessions = summarizeJellyfinSessions(await res.json());
                } catch (e) { sessions = null; }
            }
            return { ok: true, reachable: true, version: info.Version || null, serverName: info.ServerName || null, sessions };
        },
        synology: async function() {
            const k = await kumaRaw;
            const mon = k.monitors.find(function(m) { return /^synology/i.test(m.name); });
            if (!mon) throw new Error('no Synology monitor in Kuma');
            let last = null;
            try { last = (await runsRaw).synology; } catch (e) { /* archive unavailable */ }
            return {
                ok: true, reachable: mon.status === 1,
                lastBackupAt: last ? last.lastBackupAt : null,
                lastBackupResult: last ? last.lastBackupResult : null,
            };
        },
        labelmaker: async function() { return reachable(setting(env, 'APPS_LABELMAKER_URL')); },
    };

    const apps = {};
    await Promise.all(Object.keys(sources).map(async function(name) {
        let result;
        try {
            result = await withTimeout(sources[name](), SOURCE_TIMEOUT_MS + 500);
        } catch (e) {
            result = { ok: false, error: String((e && e.message) || e).slice(0, 120) };
        }
        const reason = result.ok === false ? result.error : (result.reachable === false ? (result.reason || 'unreachable') : null);
        delete result.reason;
        noteHealth(name, reason === null, reason);
        apps[name] = result;
    }));
    // Stable key order for readability.
    const ordered = {};
    Object.keys(sources).forEach(function(n) { ordered[n] = apps[n]; });
    return { generatedAt: nowSec, apps: ordered };
}

// ---------------------------------------------------------------------------
// Cached entry point
// ---------------------------------------------------------------------------

let cache = null;      // { at, value }
let inflight = null;

/**
 * Returns the aggregate, cached for CACHE_TTL_MS; concurrent callers share
 * one in-flight refresh.
 * @param {object} [deps] injectable deps (tests)
 */
function getApps(deps) {
    const now = Date.now();
    if (cache && now - cache.at < CACHE_TTL_MS) return Promise.resolve(cache.value);
    if (inflight) return inflight;
    inflight = collectApps(deps).then(function(value) {
        cache = { at: Date.now(), value };
        return value;
    }).finally(function() { inflight = null; });
    return inflight;
}

/** Test helper: clears cache, in-flight state, and outage memory. */
function resetForTests() {
    cache = null;
    inflight = null;
    failing.clear();
}

module.exports = {
    getApps, collectApps, resetForTests,
    parseKumaMetrics, parseRunsTail, summarizeRuns, parseRunning, nextResticRun,
    summarizeHost, summarizeUps, summarizeJellyfinSessions, jobLabel,
};
