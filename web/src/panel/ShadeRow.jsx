// Apollo v2 dashboard -- the Somfy shade row in the room command panel
// (kind 'shade'). Same chrome as a dim DeviceRow, but the fill/level tracks
// position (0 = open, 100 = closed) instead of brightness, and commits are
// always 'release' mode (Insteon/Somfy can't absorb a live stream).

import { commands } from '../state/index.js';
import { useDragGesture } from './useDragGesture.js';

const ROW_HEIGHT = 46;
const FONT = "'Outfit', system-ui, sans-serif";
const ROW_BORDER = '1px solid rgba(234, 229, 239, 0.11)';
const ROW_BG = 'rgba(234, 229, 239, 0.03)';
const OFF_DOT = 'rgba(234, 229, 239, 0.18)';
const AMBER = 'var(--amber, #f2a65e)';

function positionLabel(position) {
  if (position <= 0) return 'Open';
  if (position >= 100) return 'Closed';
  return `${position}%`;
}

function ShadeRow({ entry }) {
  const view = commands.deviceView(entry);

  const gesture = useDragGesture({
    startValue: view.position,
    commitMode: view.commit, // shades are always 'release' via commitMode()
    onPreview: (val) => commands.previewPosition(entry, val),
    onCommit: (val) => commands.commitPosition(entry, val),
    onTap: () => commands.toggleShade(entry),
  });

  const dotColor = view.on ? AMBER : OFF_DOT;
  const dimmedOut = view.reachable === false || view.stale;

  return (
    <div
      onPointerDown={gesture.onPointerDown}
      onPointerMove={gesture.onPointerMove}
      onPointerUp={gesture.onPointerUp}
      onPointerCancel={gesture.onPointerCancel}
      style={{
        position: 'relative',
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
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          inset: 0,
          width: `${view.position}%`,
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
            shade
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
          {positionLabel(view.position)}
        </span>
      </div>
    </div>
  );
}

export default ShadeRow;
