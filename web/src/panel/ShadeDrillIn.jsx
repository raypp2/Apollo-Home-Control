// Apollo v2 dashboard -- Shade drill-in: per-shade control behind ShadeRow's
// '>' chevron (see ShadeRow.jsx).
//
// Mounted and state-owned entirely from within ShadeRow (a local `useState`
// there, exactly like RoomPanel's `accentDrillInOpen` owns AccentDrillIn) so
// RoomPanel itself needs no changes. Unlike AccentDrillIn/DrillInShell this
// renders INLINE below the row rather than as a full-panel absolute overlay:
// DrillInShell's `position:absolute; inset:0` is anchored to RoomPanel's
// outer positioned container, which only works because AccentDrillIn is
// mounted as RoomPanel's own direct child. Mounted several levels deeper
// (inside the scrollable device list), that same overlay would be clipped by
// the scroll container's `overflow:auto` -- so this stays a normal-flow card
// instead, styled to match the same row/drag language as ShadeRow/DeviceRow.
//
// Each of the three named shades ('one'/'two'/'three') get their own tap-to-
// toggle + drag-to-set row, fed by `entry.live.positions` (absent until the
// bridge has published at least one event for that shade -- shown as '—').

import { commands } from '../state/index.js';
import { useDragGesture } from './useDragGesture.js';

const FONT = "'Outfit', system-ui, sans-serif";
const ROW_BORDER = '1px solid rgba(234, 229, 239, 0.11)';
const ROW_BG = 'rgba(234, 229, 239, 0.03)';
const CARD_BG = 'rgba(234, 229, 239, 0.045)';
const OFF_DOT = 'rgba(234, 229, 239, 0.18)';
const AMBER = 'var(--amber, #f2a65e)';
const SUB_ROW_HEIGHT = 40;

const SHADES = [
  { key: 'one', label: 'Shade One' },
  { key: 'two', label: 'Shade Two' },
  { key: 'three', label: 'Shade Three' },
];

function positionLabel(position) {
  if (position == null) return '—';
  if (position <= 0) return 'Open';
  if (position >= 100) return 'Closed';
  return `${position}%`;
}

/**
 * @param {object} props
 * @param {object} props.entry - the shades device entry
 * @param {string} props.shadeKey - 'one'|'two'|'three'
 * @param {string} props.label
 */
function ShadeSubRow({ entry, shadeKey, label }) {
  const position = commands.positionOfShade(entry, shadeKey);
  const value = position == null ? 0 : position;
  const on = value > 0;

  const gesture = useDragGesture({
    startValue: value,
    commitMode: 'release',
    onPreview: (val) => commands.previewShadePosition(entry, shadeKey, val),
    onCommit: (val) => commands.commitShadePosition(entry, shadeKey, val),
    onTap: () => commands.toggleShadeOne(entry, shadeKey),
  });

  return (
    <div
      onPointerDown={gesture.onPointerDown}
      onPointerMove={gesture.onPointerMove}
      onPointerUp={gesture.onPointerUp}
      onPointerCancel={gesture.onPointerCancel}
      style={{
        position: 'relative',
        height: SUB_ROW_HEIGHT,
        borderRadius: 'var(--r-btn, 9px)',
        border: ROW_BORDER,
        background: ROW_BG,
        overflow: 'hidden',
        touchAction: 'none',
        cursor: 'pointer',
        userSelect: 'none',
      }}
    >
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          inset: 0,
          width: `${value}%`,
          background: 'linear-gradient(90deg, rgba(242, 166, 94, 0.28), rgba(242, 166, 94, 0.14))',
          pointerEvents: 'none',
        }}
      />
      <div
        style={{
          position: 'relative',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '0 12px',
        }}
      >
        <span
          aria-hidden="true"
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            flexShrink: 0,
            background: on ? AMBER : OFF_DOT,
            boxShadow: on ? `0 0 5px 1px ${AMBER}` : 'none',
          }}
        />
        <span
          style={{
            fontFamily: FONT,
            fontWeight: 500,
            fontSize: 12.5,
            color: 'var(--text, #eae5ef)',
            flex: 1,
            minWidth: 0,
          }}
        >
          {label}
        </span>
        <span
          style={{
            fontFamily: FONT,
            fontWeight: 600,
            fontSize: 11.5,
            flexShrink: 0,
            color: 'var(--text, #eae5ef)',
          }}
        >
          {positionLabel(position)}
        </span>
      </div>
    </div>
  );
}

/**
 * @param {object} props
 * @param {object} props.entry - the shades device entry (kindOf === 'shade')
 * @param {() => void} props.onBack - closes the drill-in (ShadeRow's chevron)
 */
function ShadeDrillIn({ entry, onBack }) {
  return (
    <div
      style={{
        borderRadius: 'var(--r-row, 11px)',
        border: ROW_BORDER,
        background: CARD_BG,
        padding: '12px 12px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span
          style={{
            fontFamily: FONT,
            fontWeight: 600,
            fontSize: 13,
            flex: 1,
            minWidth: 0,
            color: 'var(--text, #eae5ef)',
          }}
        >
          Shade Controls
        </span>
        <button
          type="button"
          onClick={onBack}
          style={{
            background: 'transparent',
            border: 'none',
            color: 'var(--accent, #a688e8)',
            fontFamily: FONT,
            fontWeight: 500,
            fontSize: 12,
            cursor: 'pointer',
            padding: '4px 0',
          }}
        >
          done
        </button>
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        <button
          type="button"
          onClick={() => commands.openAllShades(entry)}
          style={{
            flex: 1,
            padding: '8px 0',
            borderRadius: 'var(--r-btn, 9px)',
            border: ROW_BORDER,
            background: ROW_BG,
            color: 'var(--text, #eae5ef)',
            fontFamily: FONT,
            fontWeight: 500,
            fontSize: 12,
            cursor: 'pointer',
          }}
        >
          Open all
        </button>
        <button
          type="button"
          onClick={() => commands.closeAllShades(entry)}
          style={{
            flex: 1,
            padding: '8px 0',
            borderRadius: 'var(--r-btn, 9px)',
            border: ROW_BORDER,
            background: ROW_BG,
            color: 'var(--text, #eae5ef)',
            fontFamily: FONT,
            fontWeight: 500,
            fontSize: 12,
            cursor: 'pointer',
          }}
        >
          Close all
        </button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {SHADES.map((shade) => (
          <ShadeSubRow key={shade.key} entry={entry} shadeKey={shade.key} label={shade.label} />
        ))}
      </div>

      <div
        style={{
          fontFamily: FONT,
          fontWeight: 300,
          fontSize: 10.5,
          color: 'rgba(234, 229, 239, 0.4)',
        }}
      >
        tap a shade to toggle · hold + drag to set a level
      </div>
    </div>
  );
}

export default ShadeDrillIn;
