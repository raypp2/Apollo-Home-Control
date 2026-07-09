// Apollo v2 dashboard -- AV increment 4: shared dB-native volume bar used by
// both the AvCluster row and the AvDrillIn "main volume" control.
//
// Unlike the dim/shade rows (useDragGesture, relative delta-from-start drag),
// this is a plain position-based slider: tap or drag anywhere on the bar sets
// the value to that horizontal position, same as a native <input type=range>
// would. The bar maps a fixed dB window [-80, 0] onto 0-100%; 0% = -80 dB
// (near-silent), 100% = 0 dB (unity/full).

import { useRef, useState } from 'preact/hooks';

const FONT = "'Outfit', system-ui, sans-serif";
const BAR_HEIGHT = 34;
export const DB_MIN = -80;
export const DB_MAX = 0;

/** Minimum ms between onChange calls while dragging (network sends are real
 * /api commands, not local-only -- throttle like the live-commit dim rows). */
const DRAG_THROTTLE_MS = 100;

/** 0-100 position -> dB in [-80, 0]. */
export function pctToDb(pct) {
  return Math.round(DB_MIN + (pct / 100) * (DB_MAX - DB_MIN));
}

/** dB in [-80, 0] -> 0-100 position. */
export function dbToPct(db) {
  const clamped = Math.max(DB_MIN, Math.min(DB_MAX, db));
  return ((clamped - DB_MIN) / (DB_MAX - DB_MIN)) * 100;
}

/**
 * @param {object} props
 * @param {number} props.db - current volume in dB (negative)
 * @param {boolean} props.disabled - dim + inert when the receiver is off
 * @param {(db:number)=>void} props.onChange - fires on tap and on every drag
 *   move (position-based, so there's no separate preview/commit split).
 * @param {boolean} [props.compact] - slim-footer variant: shorter bar, no
 *   "Volume" label row -- the dB reading is overlaid on the bar itself.
 *   Used by AvCluster's pinned strip; AvDrillIn keeps the full variant.
 */
function VolumeBar({ db, disabled, onChange, compact = false }) {
  const trackRef = useRef(null);
  const dragRef = useRef(null); // { lastSend } while a drag is in progress
  // Local display value while dragging, so the fill tracks the finger at full
  // rate even though the actual onChange (a real /api send) is throttled.
  const [dragDb, setDragDb] = useState(null);

  function valueFromEvent(event) {
    const rect = trackRef.current.getBoundingClientRect();
    const pct = rect.width > 0 ? ((event.clientX - rect.left) / rect.width) * 100 : 0;
    return pctToDb(Math.max(0, Math.min(100, pct)));
  }

  function onPointerDown(event) {
    if (disabled) return;
    if (event.currentTarget.setPointerCapture) {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    const val = valueFromEvent(event);
    dragRef.current = { lastSend: Date.now() };
    setDragDb(val);
    onChange(val);
  }

  function onPointerMove(event) {
    if (disabled || !dragRef.current || event.buttons === 0) return;
    const val = valueFromEvent(event);
    setDragDb(val);
    const now = Date.now();
    if (now - dragRef.current.lastSend >= DRAG_THROTTLE_MS) {
      dragRef.current.lastSend = now;
      onChange(val);
    }
  }

  function endDrag(event) {
    if (!dragRef.current) return;
    dragRef.current = null;
    // Final commit always fires so the last position (possibly skipped by
    // the throttle) actually reaches the receiver.
    onChange(valueFromEvent(event));
    setDragDb(null);
  }

  const displayDb = dragDb !== null ? dragDb : db;
  const pct = dbToPct(displayDb);
  const barHeight = compact ? 24 : BAR_HEIGHT;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: compact ? 0 : 4 }}>
      {!compact && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <span
            style={{
              fontFamily: FONT,
              fontWeight: 500,
              fontSize: 11,
              letterSpacing: '0.04em',
              textTransform: 'uppercase',
              color: 'var(--text-tertiary, rgba(234, 229, 239, 0.32))',
            }}
          >
            Volume
          </span>
          <span
            style={{
              fontFamily: FONT,
              fontWeight: 600,
              fontSize: 12,
              color: 'var(--text, #eae5ef)',
            }}
          >
            {Math.round(displayDb)} dB
          </span>
        </div>
      )}
      <div
        ref={trackRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        style={{
          position: 'relative',
          height: barHeight,
          borderRadius: 'var(--r-row, 11px)',
          border: '1px solid rgba(234, 229, 239, 0.11)',
          background: 'rgba(234, 229, 239, 0.03)',
          overflow: 'hidden',
          touchAction: 'none',
          cursor: disabled ? 'default' : 'pointer',
          opacity: disabled ? 0.35 : 1,
          pointerEvents: disabled ? 'none' : 'auto',
          userSelect: 'none',
        }}
      >
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            inset: 0,
            width: `${pct}%`,
            background: 'linear-gradient(90deg, var(--accent-fill, rgba(166, 136, 232, 0.28)), rgba(166, 136, 232, 0.12))',
            pointerEvents: 'none',
          }}
        />
        {compact && (
          <span
            aria-hidden="true"
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'flex-end',
              paddingRight: 10,
              fontFamily: FONT,
              fontWeight: 600,
              fontSize: 11,
              color: 'var(--text, #eae5ef)',
              pointerEvents: 'none',
            }}
          >
            {Math.round(displayDb)} dB
          </span>
        )}
      </div>
    </div>
  );
}

export default VolumeBar;
