import { store } from '../state/index.js';

// Apollo v2 dashboard -- increment 5's system status screen: the full-panel
// view behind the status strip's "All systems normal ›" button (see
// documentation/dashboard-redesign-plan.md §5.6). Four sections in order --
// Connection, Bridges, Devices, Links -- covering strictly more ground than
// the strip's one-line summary: the strip tells you *that* something's off,
// this tells you *what*.
//
// Self-contained like StatusStrip.jsx (inline styles, no status.css) for the
// same reason documented there: this folder's esbuild smoke check bundles
// everything reachable from status/index.js, and keeping CSS out of the mix
// keeps that check simple. It also means this file doesn't reach into
// panel/DrillInShell.jsx for overlay chrome -- status/ owns its own overlay
// shell rather than importing one from a folder outside its boundary.

const FONT = "'Outfit', system-ui, sans-serif";
const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

const DOT_RED = '#e86a6a';

const overlay = {
  position: 'fixed',
  inset: 0,
  zIndex: 1000,
  background: 'var(--bg-drill, #16131c)',
  display: 'flex',
  flexDirection: 'column',
  color: 'var(--text, #eae5ef)',
};

const header = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '24px 26px 14px',
  flexShrink: 0,
  borderBottom: '1px solid var(--hairline, rgba(234, 229, 239, 0.1))',
};

const backBtn = {
  background: 'transparent',
  border: 'none',
  color: 'var(--accent, #a688e8)',
  fontFamily: FONT,
  fontWeight: 500,
  fontSize: 13.5,
  cursor: 'pointer',
  padding: '6px 10px 6px 0',
};

const body = {
  flex: 1,
  overflowY: 'auto',
  padding: '18px 26px 40px',
  display: 'flex',
  flexDirection: 'column',
  gap: 26,
};

const sectionLabel = {
  fontFamily: FONT,
  fontWeight: 500,
  fontSize: 11,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  color: 'var(--text-tertiary, rgba(234, 229, 239, 0.32))',
  marginBottom: 10,
};

const card = {
  borderRadius: 'var(--r-row, 11px)',
  border: '1px solid rgba(234, 229, 239, 0.11)',
  background: 'rgba(234, 229, 239, 0.03)',
};

const row = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  padding: '11px 14px',
  borderBottom: '1px solid var(--hairline, rgba(234, 229, 239, 0.1))',
};

const rowLast = {
  ...row,
  borderBottom: 'none',
};

const dot = {
  flex: 'none',
  display: 'inline-block',
  width: '8px',
  height: '8px',
  borderRadius: '50%',
};

function pillStyle(color) {
  return {
    flex: 'none',
    fontFamily: FONT,
    fontWeight: 500,
    fontSize: 11,
    letterSpacing: '0.02em',
    padding: '3px 10px',
    borderRadius: 'var(--r-pill, 999px)',
    color,
    border: `1px solid ${color}`,
    background: `${color}22`,
  };
}

/** Connection state -> { dotColor, dotGlow, text, note }. */
function connectionInfo(connectionState) {
  if (connectionState === 'live') {
    return {
      dotColor: 'var(--status-green, #7ed9a0)',
      dotGlow: true,
      text: 'Live',
      note: null,
    };
  }
  if (connectionState === 'polling') {
    return {
      dotColor: 'var(--amber, #f2a65e)',
      dotGlow: false,
      text: 'Polling',
      note: 'MQTT WebSocket is down -- falling back to HTTP polling for state.',
    };
  }
  if (connectionState === 'connecting') {
    return {
      dotColor: 'var(--amber, #f2a65e)',
      dotGlow: false,
      text: 'Connecting',
      note: 'Establishing the MQTT WebSocket connection.',
    };
  }
  return {
    dotColor: DOT_RED,
    dotGlow: false,
    text: 'Offline',
    note: "No live connection and polling isn't covering -- state may be stale.",
  };
}

/** `lastSeenMs` -> "Ns ago", or an em dash if unknown. */
function formatAge(lastSeenMs) {
  if (typeof lastSeenMs !== 'number') return '—';
  const seconds = Math.max(0, Math.round((Date.now() - lastSeenMs) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return `${hours}h ago`;
}

/**
 * Device row status, in sort/severity order (higher first).
 * @returns {{ rank: number, label: string, color: string }}
 */
function deviceStatus(entry) {
  const unreachable = entry.live && entry.live.reachable === false;
  if (unreachable) {
    return { rank: 2, label: 'unreachable', color: DOT_RED };
  }
  if (entry.stale) {
    return { rank: 1, label: 'stale', color: 'var(--amber, #f2a65e)' };
  }
  return { rank: 0, label: 'ok', color: 'var(--status-green, #7ed9a0)' };
}

const LINKS = [
  { label: 'Homebridge', href: 'http://pi.local:8581/' },
  { label: 'DMX', href: 'http://dmx.local/' },
  { label: 'Uptime Kuma (Status)', href: 'http://pi.local:3001' },
  { label: 'PM2', href: 'https://app.pm2.io/' },
  { label: 'Logs', href: '/logs/' },
  { label: 'Legacy dashboard', href: '/legacy' },
];

function ConnectionSection() {
  const info = connectionInfo(store.connection.value);
  return (
    <div>
      <div style={sectionLabel}>Connection</div>
      <div style={card}>
        <div style={rowLast}>
          <span
            aria-hidden="true"
            style={{
              ...dot,
              background: info.dotColor,
              ...(info.dotGlow
                ? { boxShadow: '0 0 6px 2px rgba(126, 217, 160, 0.45)' }
                : null),
            }}
          />
          <span style={{ fontFamily: FONT, fontWeight: 500, fontSize: 13.5 }}>{info.text}</span>
          {info.note && (
            <span
              style={{
                fontFamily: FONT,
                fontWeight: 300,
                fontSize: 12,
                color: 'var(--text-tertiary, rgba(234, 229, 239, 0.32))',
              }}
            >
              {info.note}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function BridgesSection() {
  const bridges = store.bridges.value;
  const names = Object.keys(bridges);
  return (
    <div>
      <div style={sectionLabel}>Bridges</div>
      <div style={card}>
        {names.length === 0 && (
          <div style={{ ...rowLast, color: 'var(--text-tertiary, rgba(234, 229, 239, 0.32))' }}>
            <span style={{ fontFamily: FONT, fontSize: 12.5 }}>No bridges reported yet.</span>
          </div>
        )}
        {names.map((name, index) => {
          const online = bridges[name] === 'online';
          return (
            <div key={name} style={index === names.length - 1 ? rowLast : row}>
              <span style={{ fontFamily: FONT, fontWeight: 500, fontSize: 13, flex: 1 }}>
                {name}
              </span>
              <span style={pillStyle(online ? 'var(--status-green, #7ed9a0)' : DOT_RED)}>
                {online ? 'online' : 'offline'}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DeviceRow({ entry, isLast }) {
  const status = deviceStatus(entry);
  const subline = [entry.room, entry.stateTopic].filter(Boolean).join(' · ');
  return (
    <div style={isLast ? rowLast : row}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontFamily: FONT,
            fontWeight: 500,
            fontSize: 13,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {entry.title || entry.id}
        </div>
        {subline && (
          <div
            style={{
              fontFamily: MONO,
              fontSize: 11,
              color: 'var(--text-tertiary, rgba(234, 229, 239, 0.32))',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {subline}
          </div>
        )}
      </div>
      <span
        style={{
          flex: 'none',
          fontFamily: MONO,
          fontSize: 11,
          color: 'var(--text-tertiary, rgba(234, 229, 239, 0.32))',
        }}
      >
        {formatAge(entry.lastSeenMs)}
      </span>
      <span style={pillStyle(status.color)}>{status.label}</span>
    </div>
  );
}

function DevicesSection() {
  const entries = Array.from(store.devices.value.values());
  // Stale + unreachable first (unreachable ranks above stale), then ok --
  // stable within each tier since Array.sort is stable and insertion order
  // (Map iteration order) is otherwise meaningless here.
  const sorted = entries
    .map((entry) => ({ entry, status: deviceStatus(entry) }))
    .sort((a, b) => b.status.rank - a.status.rank)
    .map((wrapped) => wrapped.entry);

  const total = entries.length;
  const normalCount = entries.filter((entry) => deviceStatus(entry).rank === 0).length;

  return (
    <div>
      <div style={sectionLabel}>Devices</div>
      <div
        style={{
          fontFamily: FONT,
          fontWeight: 400,
          fontSize: 12,
          color: 'var(--text-secondary, rgba(234, 229, 239, 0.55))',
          marginBottom: 10,
          marginTop: -6,
        }}
      >
        {total === 0
          ? 'No devices reported yet.'
          : `${normalCount} of ${total} reporting normally`}
      </div>
      {total > 0 && (
        <div style={card}>
          {sorted.map((entry, index) => (
            <DeviceRow
              key={entry.stateTopic}
              entry={entry}
              isLast={index === sorted.length - 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function LinksSection() {
  return (
    <div>
      <div style={sectionLabel}>Links</div>
      <div style={card}>
        {LINKS.map((link, index) => (
          <div key={link.href} style={index === LINKS.length - 1 ? rowLast : row}>
            <a
              href={link.href}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                fontFamily: FONT,
                fontWeight: 500,
                fontSize: 13,
                color: 'var(--accent, #a688e8)',
                textDecoration: 'none',
                flex: 1,
              }}
            >
              {link.label}
            </a>
            <span
              style={{
                fontFamily: MONO,
                fontSize: 11,
                color: 'var(--text-tertiary, rgba(234, 229, 239, 0.32))',
              }}
            >
              {link.href}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Full-panel overlay: the drill-in behind the status strip's health label.
 * @param {object} props
 * @param {() => void} props.onClose
 */
export default function StatusScreen({ onClose }) {
  return (
    <div style={overlay}>
      <div style={header}>
        <button type="button" style={backBtn} onClick={onClose}>
          &lsaquo; back
        </button>
        <div style={{ fontFamily: FONT, fontWeight: 600, fontSize: 18 }}>System status</div>
      </div>
      <div style={body}>
        <ConnectionSection />
        <BridgesSection />
        <DevicesSection />
        <LinksSection />
      </div>
    </div>
  );
}
