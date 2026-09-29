import { useEffect, useRef, useState } from 'preact/hooks';

// Live "Apps" widget grid for the System Status screen. Polls
// GET /api/system/apps every 10s while mounted. Inline styles only (status/
// convention, see StatusScreen.jsx).

const FONT = "'Outfit', system-ui, sans-serif";
const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

const ACCENT = '#a688e8';
const GREEN = '#7ed9a0';
const AMBER = '#f2a65e';
const RED = '#e86a6a';
const GREY = 'rgba(234, 229, 239, 0.35)';
const TEXT = '#eae5ef';
const TEXT2 = 'rgba(234, 229, 239, 0.6)';
const TRACK = 'rgba(234, 229, 239, 0.1)';

const POLL_MS = 10000;
const HOST_STALE_S = 60;
const SPARK_MAX = 30;

const SEV = {
  ok: { dot: GREEN, border: 'rgba(234, 229, 239, 0.1)', bg: 'rgba(234, 229, 239, 0.04)', big: TEXT },
  warn: { dot: AMBER, border: 'rgba(242, 166, 94, 0.55)', bg: 'rgba(242, 166, 94, 0.07)', big: AMBER },
  bad: { dot: RED, border: 'rgba(232, 106, 106, 0.6)', bg: 'rgba(232, 106, 106, 0.08)', big: RED },
  unknown: { dot: GREY, border: 'rgba(234, 229, 239, 0.1)', bg: 'rgba(234, 229, 239, 0.04)', big: TEXT2 },
};

// Link data (hrefs/hosts) for each card.
const LINKS = {
  host: { label: 'Pi host', href: 'https://apollo-pi.mahi-goldeye.ts.net/', host: 'details on Archive status' },
  ups: { label: 'PeaNUT', href: 'http://pi.local:8080/', host: 'pi.local:8080' },
  kuma: { label: 'Uptime Kuma', href: 'http://pi.local:3001', host: 'pi.local:3001' },
  archive: { label: 'Archive status', href: 'https://apollo-pi.mahi-goldeye.ts.net/', host: 'tailnet only' },
  synology: { label: 'Synology DSM', href: 'http://100.104.252.39:5000/', host: 'DSM (tailnet)' },
  jellyfin: { label: 'Jellyfin', href: 'http://pi.local:8096/', host: 'pi.local:8096' },
  homebridge: { label: 'Homebridge', href: 'http://pi.local:8581/', host: 'pi.local:8581' },
  dmx: { label: 'DMX', href: 'http://dmx.local/', host: 'dmx.local' },
  healthchecks: { label: 'Healthchecks', href: 'https://healthchecks.io/', host: 'healthchecks.io' },
  labelmaker: { label: 'Label Maker', href: 'http://pi.local:8082/', host: 'pi.local:8082' },
};

// ---------------------------------------------------------------- helpers

function useWide() {
  const query = '(min-width: 900px)';
  const [wide, setWide] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query).matches : false,
  );
  useEffect(() => {
    if (!window.matchMedia) return undefined;
    const mql = window.matchMedia(query);
    const onChange = () => setWide(mql.matches);
    onChange();
    if (mql.addEventListener) mql.addEventListener('change', onChange);
    else mql.addListener(onChange);
    return () => {
      if (mql.removeEventListener) mql.removeEventListener('change', onChange);
      else mql.removeListener(onChange);
    };
  }, []);
  return wide;
}

function nowS() {
  return Date.now() / 1000;
}

function ago(unixS) {
  if (typeof unixS !== 'number') return '—';
  const s = Math.max(0, Math.round(nowS() - unixS));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function fmtBytes(n) {
  if (typeof n !== 'number') return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i += 1;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

function fmtUptime(s) {
  if (typeof s !== 'number') return '—';
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function fmtClock(unixS) {
  if (typeof unixS !== 'number') return '—';
  return new Date(unixS * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

function fmtDataAdded(n) {
  if (typeof n !== 'number') return '0 B';
  return fmtBytes(n);
}

// ------------------------------------------------------------ small pieces

const bigStyle = (color) => ({
  fontFamily: FONT,
  fontWeight: 500,
  fontSize: 22,
  lineHeight: 1.15,
  color,
});
const lineStyle = { fontFamily: FONT, fontSize: 12, color: TEXT2, lineHeight: 1.35 };
const statLabel = {
  fontFamily: FONT,
  fontSize: 10.5,
  letterSpacing: '0.05em',
  textTransform: 'uppercase',
  color: TEXT2,
};

function Big({ color, children, suffix }) {
  return (
    <div style={bigStyle(color)}>
      {children}
      {suffix && <span style={{ fontSize: 13, fontWeight: 400, color: TEXT2 }}> {suffix}</span>}
    </div>
  );
}

function Line({ children, color }) {
  return <div style={color ? { ...lineStyle, color } : lineStyle}>{children}</div>;
}

function Bar({ pct, color, height = 4, marker }) {
  const p = Math.max(0, Math.min(100, pct));
  return (
    <div style={{ position: 'relative', height, borderRadius: height, background: TRACK }}>
      <div style={{ width: `${p}%`, height: '100%', borderRadius: height, background: color }} />
      {marker != null && (
        <div
          style={{
            position: 'absolute',
            top: -3,
            bottom: -3,
            left: `${marker}%`,
            width: 1.5,
            background: AMBER,
          }}
        />
      )}
    </div>
  );
}

// CPU history chart, drawn like the Archive status page's canvas: fixed
// 0-100% scale, faint gridlines at 25/50/75%, a filled area under a 1.5px
// accent line, growing in from the left until the window fills.
function CpuChart({ samples }) {
  const W = 300;
  const H = 76;
  const n = SPARK_MAX;
  const xy = (i, v) => [
    (i / (n - 1)) * W,
    H - (Math.max(0, Math.min(100, v)) / 100) * (H - 4) - 2,
  ];
  let line = '';
  let area = '';
  if (samples.length >= 2) {
    const pts = samples.map((v, i) => xy(i, v).map((c) => c.toFixed(1)).join(','));
    line = pts.join(' ');
    const lastX = (((samples.length - 1) / (n - 1)) * W).toFixed(1);
    area = `0,${H} ${line} ${lastX},${H}`;
  }
  return (
    <div
      aria-hidden="true"
      style={{ height: H, borderRadius: 11, overflow: 'hidden', background: 'rgba(234, 229, 239, 0.04)' }}
    >
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" width="100%" height={H} style={{ display: 'block' }}>
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} x1="0" x2={W} y1={H * f} y2={H * f} stroke="rgba(234,229,239,.08)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        ))}
        {area && <polygon points={area} fill="rgba(166,136,232,.16)" />}
        {line && <polyline points={line} fill="none" stroke={ACCENT} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />}
      </svg>
    </div>
  );
}

// Styles lifted from the Archive status page's "Backup host" section so the
// two read as the same instrument.
const H_TERT = 'rgba(234, 229, 239, 0.32)';
const H_HAIR = 'rgba(234, 229, 239, 0.1)';
const hUnit = (size) => ({ fontSize: size, color: H_TERT, marginLeft: 2, fontWeight: 400 });
const hCaps = { fontFamily: FONT, fontSize: 10, fontWeight: 500, letterSpacing: '0.16em', textTransform: 'uppercase', color: H_TERT };

function HostRow({ k, v, color, last }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        gap: 12,
        fontFamily: FONT,
        fontSize: 13,
        padding: '8px 0',
        borderBottom: last ? 'none' : `1px solid ${H_HAIR}`,
      }}
    >
      <span style={{ color: H_TERT }}>{k}</span>
      <span style={{ color: color || TEXT, fontWeight: 500, textAlign: 'right' }}>{v}</span>
    </div>
  );
}

function KV({ k, v, color }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, ...lineStyle, padding: '2px 0' }}>
      <span>{k}</span>
      <span style={{ color: color || TEXT, fontWeight: 500 }}>{v}</span>
    </div>
  );
}

const NOT_REPORTING = <Line>Not reporting</Line>;

// ------------------------------------------------------ per-app view models
// Each returns { sev, aria, body, span } (span: 'full' | 2 | 1).

function hostModel(d, samples, wide, nowSec) {
  if (!d || !d.ok || typeof d.updated !== 'number' || nowSec - d.updated > HOST_STALE_S) {
    return { sev: 'unknown', aria: 'Pi host: not reporting', body: NOT_REPORTING, span: 'full' };
  }
  const t = d.socTempC;
  const th = d.throttle || {};
  const warn = t >= 75 || th.throttledNow || th.underVoltageNow;
  const sev = warn ? 'warn' : 'ok';
  const tempNote = t >= 75 ? 'throttling' : t >= 65 ? 'warm under load, clear of throttling' : 'cool';
  const cores = Object.entries(d.cores || {});
  const load1 = Array.isArray(d.load) ? d.load[0] : null;
  const diskLow = typeof d.diskFreeBytes === 'number' && d.diskFreeBytes < 2e9;
  const hot = t >= 75;
  const tempColor = hot ? AMBER : GREEN;
  const left = (
    <div style={{ minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, marginBottom: 10 }}>
        <span style={{ fontFamily: FONT, fontSize: 40, fontWeight: 300, lineHeight: 1, color: ACCENT }}>
          {Number(d.cpuAvg).toFixed(0)}
          <span style={hUnit(15)}>%</span>
        </span>
        <span style={hCaps}>processor · {cores.length || 4} cores</span>
      </div>
      <CpuChart samples={samples} />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 7, marginTop: 10 }}>
        {cores.map(([name, v]) => (
          <div key={name} style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <span style={{ height: 4, borderRadius: 999, background: 'rgba(234, 229, 239, 0.08)', overflow: 'hidden' }}>
              <i style={{ display: 'block', height: '100%', width: `${Math.max(0, Math.min(100, v)).toFixed(0)}%`, background: ACCENT, borderRadius: 999 }} />
            </span>
            <span style={{ fontFamily: FONT, fontSize: 10, letterSpacing: '0.1em', color: H_TERT }}>{name}</span>
          </div>
        ))}
      </div>
    </div>
  );
  const fillPct = Math.max(0, Math.min(100, ((t - 30) / 60) * 100));
  const right = (
    <div style={{ minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 11 }}>
        <span style={{ fontFamily: FONT, fontSize: 30, fontWeight: 300, lineHeight: 1, color: tempColor }}>
          {Number(t).toFixed(1)}
          <span style={hUnit(13)}>°C</span>
        </span>
        <span style={{ fontFamily: FONT, fontSize: 11, color: 'rgba(234, 229, 239, 0.55)' }}>{tempNote}</span>
      </div>
      <div style={{ position: 'relative', height: 9, borderRadius: 999, background: 'rgba(234, 229, 239, 0.07)', margin: '22px 0 8px' }}>
        <span style={{ position: 'absolute', top: 0, bottom: 0, left: 0, width: `${fillPct.toFixed(1)}%`, borderRadius: 999, background: tempColor, boxShadow: `0 0 12px ${tempColor}` }} />
        <span style={{ position: 'absolute', top: -4, bottom: -4, left: '75%', width: 2, borderRadius: 2, background: AMBER }}>
          <span style={{ position: 'absolute', top: -16, left: '50%', transform: 'translateX(-50%)', fontFamily: FONT, fontSize: 10, fontWeight: 500, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#f2c79a', whiteSpace: 'nowrap' }}>
            throttles at 75°
          </span>
        </span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: FONT, fontSize: 10, letterSpacing: '0.1em', color: H_TERT, marginBottom: 16 }}>
        <span>30°</span><span>60°</span><span>90°</span>
      </div>
      <HostRow
        k="Throttled since boot"
        v={th.throttledSinceBoot ? 'yes' : 'never'}
        color={th.throttledSinceBoot ? '#f2c79a' : GREEN}
      />
      <HostRow k="Load" v={load1 != null ? Number(load1).toFixed(2) : '—'} />
      <HostRow k="Uptime" v={fmtUptime(d.uptimeSeconds)} />
      <HostRow k="Disk free" v={fmtBytes(d.diskFreeBytes)} color={diskLow ? RED : TEXT} last />
    </div>
  );
  return {
    sev,
    aria: `Pi host: CPU ${Number(d.cpuAvg).toFixed(0)} percent, ${Number(t).toFixed(0)} degrees, ${tempNote}`,
    body: (
      <div style={{ display: 'grid', gridTemplateColumns: wide ? '1.25fr 1fr' : '1fr', gap: wide ? 26 : 24, alignItems: 'start', marginTop: 4 }}>
        {left}
        {right}
      </div>
    ),
    span: 'full',
  };
}

function upsModel(d) {
  if (!d || !d.ok) return { sev: 'unknown', aria: 'PeaNUT: not reporting', body: NOT_REPORTING, span: 2 };
  let sev = 'ok';
  if (d.onBattery && d.lowBattery) sev = 'bad';
  else if (d.onBattery || d.lowBattery) sev = 'warn';
  const side = d.onBattery
    ? d.lowBattery ? 'Battery low' : 'Discharging'
    : d.lowBattery
      ? d.charging ? 'Battery low · charging' : 'Battery low'
      : d.charging ? 'Charging' : 'Battery full';
  const battColor = d.onBattery || d.lowBattery ? AMBER : GREEN;
  const runMin = typeof d.runtimeSeconds === 'number' ? Math.round(d.runtimeSeconds / 60) : '—';
  const stat = (label, value) => (
    <div>
      <div style={statLabel}>{label}</div>
      <div style={{ fontFamily: FONT, fontWeight: 500, fontSize: 15, color: TEXT }}>{value}</div>
    </div>
  );
  return {
    sev,
    aria: `PeaNUT: ${d.onBattery ? 'on battery' : 'on mains'}, battery ${d.batteryPct} percent`,
    span: 2,
    body: (
      <div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
          <div style={bigStyle(d.onBattery ? AMBER : TEXT)}>{d.onBattery ? 'On battery' : 'On mains'}</div>
          <div style={lineStyle}>{side}</div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8, margin: '10px 0 8px' }}>
          {stat('Battery', `${d.batteryPct}%`)}
          {stat('Runtime', `${runMin} min`)}
          {stat('Load', `${d.loadPct}%`)}
        </div>
        <Bar pct={d.batteryPct} color={battColor} height={6} />
      </div>
    ),
  };
}

function kumaModel(d) {
  if (!d || !d.ok) return { sev: 'unknown', aria: 'Uptime Kuma: not reporting', body: NOT_REPORTING, span: 1 };
  const down = d.down || [];
  const sev = down.length ? 'bad' : 'ok';
  const sub = down.length
    ? `${down[0]} down${down.length > 1 ? ` (+${down.length - 1} more)` : ''}`
    : 'all monitors up';
  return {
    sev,
    aria: `Uptime Kuma: ${d.up} of ${d.total} up`,
    span: 1,
    body: (
      <div>
        <div style={bigStyle(SEV[sev].big)}>
          {d.up}
          <span style={{ fontSize: 13, fontWeight: 400, color: TEXT2 }}> / {d.total} up</span>
        </div>
        <Line color={down.length ? RED : undefined}>{sub}</Line>
      </div>
    ),
  };
}

function archiveModel(d) {
  if (!d || !d.ok) return { sev: 'unknown', aria: 'Archive status: not reporting', body: NOT_REPORTING, span: 1 };
  const failing = d.failingJobs || [];
  const running = d.running || [];
  const sev = failing.length ? 'bad' : 'ok';
  const last = d.lastRun;
  const runLine = running.length ? (
    <Line color={ACCENT}>
      Running: {running[0].job}
      {typeof running[0].pct === 'number' ? ` ${Math.round(running[0].pct)}%` : ''}
    </Line>
  ) : null;
  if (failing.length) {
    return {
      sev,
      aria: `Archive status: ${failing[0].job} failed`,
      span: 1,
      body: (
        <div>
          <div style={bigStyle(RED)}>Failed</div>
          <Line>
            {failing[0].job} · {ago(failing[0].finished)}
          </Line>
          <Line>
            {failing.length} failing · next {fmtClock(d.nextRunAt)}
          </Line>
          {runLine}
        </div>
      ),
    };
  }
  return {
    sev,
    aria: `Archive status: last success ${ago(d.lastSuccessAt)}`,
    span: 1,
    body: (
      <div>
        <div style={bigStyle(TEXT)}>{ago(d.lastSuccessAt)}</div>
        {last && (
          <Line>
            {last.job} · +{fmtDataAdded(last.dataAdded)}
          </Line>
        )}
        <Line>0 failing · next {fmtClock(d.nextRunAt)}</Line>
        {runLine}
      </div>
    ),
  };
}

function synologyModel(d) {
  if (!d || !d.ok) return { sev: 'unknown', aria: 'Synology DSM: not reporting', body: NOT_REPORTING, span: 1 };
  const bad = !d.reachable || d.lastBackupResult !== 'ok';
  const sev = bad ? 'bad' : 'ok';
  const big = !d.reachable ? 'Unreachable' : d.lastBackupResult !== 'ok' ? 'Backup failed' : 'Healthy';
  return {
    sev,
    aria: `Synology DSM: ${big}`,
    span: 1,
    body: (
      <div>
        <div style={bigStyle(SEV[sev].big)}>{big}</div>
        <Line>Last backup {ago(d.lastBackupAt)}</Line>
        <Line color={d.lastBackupResult === 'ok' ? undefined : RED}>Result: {d.lastBackupResult || '—'}</Line>
      </div>
    ),
  };
}

function jellyfinModel(d) {
  if (!d || !d.ok) return { sev: 'unknown', aria: 'Jellyfin: not reporting', body: NOT_REPORTING, span: 1 };
  if (!d.reachable) {
    return {
      sev: 'bad',
      aria: 'Jellyfin: unreachable',
      span: 1,
      body: <div style={bigStyle(RED)}>Offline</div>,
    };
  }
  if (!Array.isArray(d.sessions)) {
    return {
      sev: 'ok',
      aria: 'Jellyfin: online',
      span: 1,
      body: (
        <div>
          <div style={bigStyle(TEXT)}>Online</div>
          {d.version && <Line>v{d.version}</Line>}
        </div>
      ),
    };
  }
  const n = d.sessions.length;
  const first = d.sessions[0];
  return {
    sev: 'ok',
    aria: `Jellyfin: ${n ? `${n} streaming` : 'idle'}`,
    span: 1,
    body: (
      <div>
        <div style={bigStyle(TEXT)}>{n ? `${n} streaming` : 'Idle'}</div>
        {first ? (
          <Line>
            {first.title} · {first.device}
          </Line>
        ) : (
          d.version && <Line>v{d.version}</Line>
        )}
      </div>
    ),
  };
}

function homebridgeModel(d) {
  if (!d || !d.ok) return { sev: 'unknown', aria: 'Homebridge: not reporting', body: NOT_REPORTING, span: 1 };
  const sev = d.running ? 'ok' : 'bad';
  return {
    sev,
    aria: `Homebridge: ${d.running ? 'running' : 'stopped'}`,
    span: 1,
    body: (
      <div>
        <div style={bigStyle(SEV[sev].big)}>{d.running ? 'Running' : 'Stopped'}</div>
        {d.version && <Line>v{d.version}</Line>}
      </div>
    ),
  };
}

function dmxModel(d) {
  if (!d || !d.ok) return { sev: 'unknown', aria: 'DMX: not reporting', body: NOT_REPORTING, span: 1 };
  const sev = d.reachable ? 'ok' : 'bad';
  return {
    sev,
    aria: `DMX: ${d.reachable ? 'online' : 'offline'}`,
    span: 1,
    body: <div style={bigStyle(SEV[sev].big)}>{d.reachable ? 'Online' : 'Offline'}</div>,
  };
}

function slimModel(name, ok, reachable) {
  // ok: always-on link (Healthchecks has no data source); else reachable flag.
  const known = ok || reachable !== undefined;
  const sev = ok ? 'ok' : !known ? 'unknown' : reachable ? 'ok' : 'warn';
  return { sev, aria: `${name}: ${sev === 'ok' ? 'link' : sev === 'warn' ? 'unreachable' : 'not reporting'}`, slim: true, span: 2 };
}

// ---------------------------------------------------------------- cards

function Card({ id, model, wide }) {
  const link = LINKS[id];
  const s = SEV[model.sev];
  const cols = wide ? 4 : 2;
  const span = model.span === 'full' ? cols : model.span;
  const anchor = {
    gridColumn: `span ${span}`,
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    minWidth: 0,
    boxSizing: 'border-box',
    borderRadius: 14,
    border: `1px solid ${s.border}`,
    background: s.bg,
    padding: '12px 14px',
    textDecoration: 'none',
    color: 'inherit',
    ...(model.slim ? { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 8 } : null),
  };
  const dotEl = (
    <span
      aria-hidden="true"
      style={{ flex: 'none', width: 8, height: 8, borderRadius: '50%', background: s.dot }}
    />
  );
  const arrow = (
    <span aria-hidden="true" style={{ color: ACCENT, fontSize: 14 }}>
      &#8599;
    </span>
  );
  const name = (
    <span style={{ fontFamily: FONT, fontWeight: 500, fontSize: 13, color: TEXT }}>{link.label}</span>
  );
  return (
    <a
      href={link.href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={model.aria}
      style={anchor}
    >
      {model.slim ? (
        <>
          {dotEl}
          {name}
          <span style={{ flex: 1, fontFamily: MONO, fontSize: 10.5, color: TEXT2, textAlign: 'right' }}>
            {link.host}
          </span>
          {arrow}
        </>
      ) : (
        <>
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {dotEl}
            <span style={{ flex: 1, minWidth: 0 }}>{name}</span>
            {arrow}
          </span>
          {model.body}
          <span style={{ marginTop: 'auto', fontFamily: MONO, fontSize: 10.5, color: TEXT2 }}>
            {link.host}
          </span>
        </>
      )}
    </a>
  );
}

// ---------------------------------------------------------------- section

const sectionLabel = {
  fontFamily: FONT,
  fontWeight: 500,
  fontSize: 11,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  color: 'var(--text-tertiary, rgba(234, 229, 239, 0.32))',
  marginBottom: 10,
};

export default function AppsSection() {
  const wide = useWide();
  const [apps, setApps] = useState(null); // last good payload's `apps`
  const [, setTick] = useState(0);
  const [samples, setSamples] = useState([]);
  const lastUpdated = useRef(null);

  useEffect(() => {
    let alive = true;
    let timer = null;
    async function poll() {
      try {
        const res = await fetch('/api/system/apps');
        if (!res.ok) throw new Error(`status ${res.status}`);
        const json = await res.json();
        if (!alive || !json || !json.apps) return;
        setApps(json.apps);
        const h = json.apps.host;
        if (h && h.ok && typeof h.cpuAvg === 'number' && h.updated !== lastUpdated.current) {
          lastUpdated.current = h.updated;
          setSamples((prev) => [...prev, h.cpuAvg].slice(-SPARK_MAX));
        }
      } catch (err) {
        // Keep the last good payload; still re-render so relative times age.
      }
      if (alive) {
        setTick((t) => t + 1);
        timer = setTimeout(poll, POLL_MS);
      }
    }
    poll();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, []);

  const a = apps || {};
  const nowSec = nowS();
  const entries = [
    ['host', hostModel(a.host, samples, wide, nowSec)],
    ['ups', upsModel(a.ups)],
    ['kuma', kumaModel(a.kuma)],
    ['archive', archiveModel(a.archive)],
    ['synology', synologyModel(a.synology)],
    ['jellyfin', jellyfinModel(a.jellyfin)],
    ['homebridge', homebridgeModel(a.homebridge)],
    ['dmx', dmxModel(a.dmx)],
    ['healthchecks', slimModel('Healthchecks', true)],
    [
      'labelmaker',
      slimModel('Label Maker', false, a.labelmaker && a.labelmaker.ok ? a.labelmaker.reachable : undefined),
    ],
  ];
  const rank = { bad: 0, warn: 1, ok: 2, unknown: 2 };
  const sorted = entries
    .map((e, i) => ({ e, i }))
    .sort((x, y) => rank[x.e[1].sev] - rank[y.e[1].sev] || x.i - y.i)
    .map((x) => x.e);
  const attention = entries.filter(([, m]) => m.sev === 'bad' || m.sev === 'warn').length;

  return (
    <div>
      <div style={sectionLabel}>
        Apps
        {attention > 0 && (
          <span style={{ color: AMBER, marginLeft: 10 }}>{attention} need attention</span>
        )}
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${wide ? 4 : 2}, minmax(0, 1fr))`,
          gap: 10,
        }}
      >
        {sorted.map(([id, model]) => (
          <Card key={id} id={id} model={model} wide={wide} />
        ))}
      </div>
    </div>
  );
}
