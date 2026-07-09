// Apollo v2 dashboard -- one light row in the room command panel (kind
// 'dim' or 'switch', see commands.kindOf). Dim rows get pointer drag-to-set
// plus a 50% quick-set button; switch rows are tap-only.

import { commands } from '../state/index.js';
import { useDragGesture } from './useDragGesture.js';
import { colorToRgba } from './colorTint.js';

const ROW_HEIGHT = 46;

const FONT = "'Outfit', system-ui, sans-serif";

const ROW_BORDER = '1px solid rgba(234, 229, 239, 0.11)';
const ROW_BG = 'rgba(234, 229, 239, 0.03)';
const OFF_DOT = 'rgba(234, 229, 239, 0.18)';
const AMBER = 'var(--amber, #f2a65e)';

function DeviceRow({ entry }) {
  const view = commands.deviceView(entry);
  const isDim = view.kind === 'dim';

  // Hook is called unconditionally (rules of hooks); only wired to the DOM
  // for dim rows -- switch rows are tap-only via a plain onClick below.
  const gesture = useDragGesture({
    startValue: view.level,
    commitMode: view.commit,
    onPreview: (val) => commands.previewLevel(entry, val),
    onCommit: (val) => commands.commitLevel(entry, val),
    onTap: () => commands.toggle(entry),
  });

  const liveColor = view.on && view.color ? view.color : null;
  const fillFrom = liveColor ? colorToRgba(liveColor, 0.28) : 'rgba(242, 166, 94, 0.28)';
  const fillTo = liveColor ? colorToRgba(liveColor, 0.14) : 'rgba(242, 166, 94, 0.14)';
  const dotColor = view.on ? (liveColor || AMBER) : OFF_DOT;
  const dimmedOut = view.reachable === false || view.stale;

  const row = (
    <div
      onPointerDown={isDim ? gesture.onPointerDown : undefined}
      onPointerMove={isDim ? gesture.onPointerMove : undefined}
      onPointerUp={isDim ? gesture.onPointerUp : undefined}
      onPointerCancel={isDim ? gesture.onPointerCancel : undefined}
      onClick={!isDim ? () => commands.toggle(entry) : undefined}
      style={{
        position: 'relative',
        flex: 1,
        minWidth: 0,
        height: ROW_HEIGHT,
        borderRadius: 'var(--r-row, 11px)',
        border: view.unconfirmed ? '1px solid rgba(242, 166, 94, 0.55)' : ROW_BORDER,
        background: ROW_BG,
        overflow: 'hidden',
        touchAction: 'none',
        cursor: 'pointer',
        opacity: dimmedOut ? 0.5 : 1,
        userSelect: 'none',
      }}
    >
      {isDim && (
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            inset: 0,
            width: `${view.level}%`,
            background: `linear-gradient(90deg, ${fillFrom}, ${fillTo})`,
            pointerEvents: 'none',
          }}
        />
      )}
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
            width: 7,
            height: 7,
            borderRadius: '50%',
            flexShrink: 0,
            background: dotColor,
            boxShadow: view.on ? `0 0 5px 1px ${dotColor}` : 'none',
          }}
        />
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
          <span
            style={{
              fontFamily: FONT,
              fontWeight: 500,
              fontSize: 13.5,
              color: 'var(--text, #eae5ef)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {view.title}
          </span>
          <span
            style={{
              fontFamily: FONT,
              fontWeight: 300,
              fontSize: 10.5,
              color: 'rgba(234, 229, 239, 0.4)',
            }}
          >
            {isDim ? 'dimmer' : 'switch'}
          </span>
        </div>
        <span
          style={{
            fontFamily: FONT,
            fontWeight: 600,
            fontSize: 12,
            flexShrink: 0,
            color: 'var(--text, #eae5ef)',
          }}
        >
          {isDim ? (view.on ? `${view.level}%` : 'Off') : (view.on ? 'On' : 'Off')}
        </span>
      </div>
    </div>
  );

  if (!isDim) return row;

  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'stretch' }}>
      {row}
      <button
        type="button"
        onClick={(event) => {
          // The row itself never sees this click (separate DOM element), but
          // stopPropagation is cheap insurance against any future wrapper
          // that adds its own click/toggle handler around this pair.
          event.stopPropagation();
          commands.commitLevel(entry, 50);
        }}
        style={{
          width: 44,
          height: ROW_HEIGHT,
          flexShrink: 0,
          borderRadius: 'var(--r-row, 11px)',
          border: ROW_BORDER,
          background: ROW_BG,
          color: 'var(--text-secondary, rgba(234, 229, 239, 0.55))',
          fontFamily: FONT,
          fontWeight: 500,
          fontSize: 11.5,
          cursor: 'pointer',
        }}
      >
        50%
      </button>
    </div>
  );
}

export default DeviceRow;
