import { useState } from 'preact/hooks';
import { store, ui } from '../state/index.js';
import StatusScreen from './StatusScreen.jsx';

// Apollo v2 dashboard -- increment 2's status strip.
//
// Bottom bar: a health dot + clickable label on the left (bridge/stale/
// connection health, see documentation/dashboard-redesign-plan.md §5.6), and
// the last-action trace on the right. Reads `store.degraded`, `store.bridges`,
// `store.connection`, `store.devices`, and `ui.lastAction` -- all
// @preact/signals, so reading `.value` here auto-subscribes this component to
// re-render on change, no extra wiring needed.
//
// Inline styles throughout (matching main.jsx's house style for this scaffold
// phase) rather than a status.css: a real CSS-file import here pulls esbuild's
// CSS bundling into play, which fights this component's own `--outfile=/dev/null`
// smoke build on macOS (esbuild insists on writing a sibling `/dev/null.css`,
// which devfs refuses). Inline keeps the JS bundle self-contained.

const DOT_RED = '#e86a6a';

const strip = {
  padding: '11px 28px',
  borderTop: '1px solid var(--hairline)',
  display: 'flex',
  flexDirection: 'row',
  justifyContent: 'space-between',
  alignItems: 'center',
  gap: '0.75rem',
};

const left = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.55rem',
  minWidth: 0,
};

const dotBase = {
  flex: 'none',
  display: 'inline-block',
  width: '8px',
  height: '8px',
  borderRadius: '50%',
};

const label = {
  appearance: 'none',
  background: 'none',
  border: 'none',
  padding: 0,
  margin: 0,
  cursor: 'pointer',
  fontFamily: "'Outfit', system-ui, sans-serif",
  fontWeight: 400,
  fontSize: '13px',
  color: 'var(--text-secondary)',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

const suffix = {
  color: 'var(--text-tertiary)',
};

const trace = {
  fontFamily: "'Outfit', system-ui, sans-serif",
  fontWeight: 300,
  fontSize: '11.5px',
  color: 'rgba(234, 229, 239, 0.30)',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

/**
 * Health precedence (highest severity wins):
 *   1. any bridge not 'online'            -> red dot,   "Bridge offline ›"
 *   2. any device entry with stale=true   -> amber dot, "N device(s) stale ›"
 *   3. otherwise                          -> green dot (glow), "All systems normal ›"
 *
 * `store.degraded` is also read here (folded in as a fallback amber trigger)
 * since the backend's `/api/health` `degraded` flag can in principle trip for
 * reasons beyond bridges/staleness (see plan §5.6's description of degraded as
 * the strip's top-level driver) -- when it's the *only* signal tripped this
 * renders a generic amber warning rather than staying silent about it.
 * @returns {{ dotColor: string, dotGlow: boolean, label: string }}
 */
function computeHealth() {
  const bridges = store.bridges.value;
  const bridgeOffline = Object.values(bridges).some((status) => status !== 'online');

  let staleCount = 0;
  for (const entry of store.devices.value.values()) {
    if (entry.stale) staleCount += 1;
  }

  const degraded = store.degraded.value;

  if (bridgeOffline) {
    return { dotColor: DOT_RED, dotGlow: false, label: 'Bridge offline ›' };
  }
  if (staleCount > 0) {
    return {
      dotColor: 'var(--amber)',
      dotGlow: false,
      label: `${staleCount} device${staleCount > 1 ? 's' : ''} stale ›`,
    };
  }
  if (degraded) {
    return { dotColor: 'var(--amber)', dotGlow: false, label: 'Degraded ›' };
  }
  return { dotColor: 'var(--status-green)', dotGlow: true, label: 'All systems normal ›' };
}

/**
 * Subtle suffix reflecting `store.connection`: 'live' is the happy path and
 * adds nothing; 'polling' means MQTT is down but the HTTP fallback is
 * covering; 'connecting'/'offline' mean the strip can't currently vouch for
 * freshness at all.
 * @param {string} connectionState
 * @returns {string}
 */
function connectionSuffix(connectionState) {
  if (connectionState === 'polling') return ' · polling';
  if (connectionState === 'offline' || connectionState === 'connecting') return ' · offline';
  return '';
}

export default function StatusStrip() {
  // Increment 5: the status screen's open/closed state lives here rather
  // than in main.jsx (which renders <StatusStrip /> and isn't ours to
  // touch) -- StatusScreen is rendered as a fixed-position overlay right
  // alongside the strip's own markup whenever `open` is true.
  const [open, setOpen] = useState(false);

  const health = computeHealth();
  const suffixText = connectionSuffix(store.connection.value);
  const traceText = ui.lastAction.value;

  return (
    <div style={strip}>
      <div style={left}>
        <span
          aria-hidden="true"
          style={{
            ...dotBase,
            background: health.dotColor,
            ...(health.dotGlow
              ? { boxShadow: '0 0 6px 2px rgba(126, 217, 160, 0.45)' }
              : null),
          }}
        />
        <button type="button" style={label} onClick={() => setOpen(true)}>
          {health.label}
          {suffixText && <span style={suffix}>{suffixText}</span>}
        </button>
      </div>
      {traceText && <div style={trace}>{traceText}</div>}
      {open && <StatusScreen onClose={() => setOpen(false)} />}
    </div>
  );
}
