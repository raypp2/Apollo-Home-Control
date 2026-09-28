// Apollo "next" preview layout -- Shades tab.
//
// Unlike the classic dashboard's ShadeRow (tap-to-expand a ShadeDrillIn
// behind a chevron), this tab has nothing else competing for space, so every
// control renders inline immediately: no expand step. Per shade group we
// show a header (name + status), Open all / Close all, a whole-group
// position bar, and each individually-named shade ('one'/'two'/'three')
// with its own position bar + toggle -- the same commands and preview/commit
// semantics as ShadeRow/ShadeDrillIn (src/panel/), just laid out flat.
//
// PositionBar below is a new, from-scratch horizontal control (not an
// extraction of ShadeRow's inline-styled row) so this file doesn't need to
// modify src/panel/ShadeRow.jsx or ShadeDrillIn.jsx, which stay behind for
// the classic dashboard at `/`. It deliberately uses `touch-action: pan-y`
// (see shades.css) instead of ShadeRow's `touch-action: none`, so a
// vertical swipe here still scrolls the tab's content -- useDragGesture only
// ever reads horizontal (clientX) movement, so that's safe.

import { store, ui, commands } from '../state/index.js';
import { useDragGesture } from '../panel/useDragGesture.js';
import './shades.css';

const SHADES = [
  { key: 'one', label: 'Shade One' },
  { key: 'two', label: 'Shade Two' },
  { key: 'three', label: 'Shade Three' },
];

// Same wording as ShadeRow.jsx's statusLabel / ShadeDrillIn.jsx's
// positionLabel (see those files' doc comments for why this is always the
// live, bridge-reported position/direction and never a locally-guessed one).
function statusLabel(position, moving) {
  if (moving === 'down') return position == null ? 'Closing' : `Closing · ${position}%`;
  if (moving === 'up') return position == null ? 'Opening' : `Opening · ${position}%`;
  if (position == null) return '—';
  if (position <= 1) return 'Open';
  if (position >= 99) return 'Closed';
  return `${position}% closed`;
}

/**
 * One horizontal drag/tap position bar, shared by the whole-group control and
 * each individual shade row.
 * @param {object} props
 * @param {string} props.label
 * @param {number} props.value - 0-100
 * @param {string} props.statusText
 * @param {boolean} [props.unconfirmed]
 * @param {(val:number)=>void} props.onPreview
 * @param {(val:number)=>void} props.onCommit
 * @param {()=>void} props.onTap
 */
function PositionBar({ label, value, statusText, unconfirmed, onPreview, onCommit, onTap }) {
  const gesture = useDragGesture({
    startValue: value,
    commitMode: 'release', // Insteon/Somfy can't absorb a live stream
    onPreview,
    onCommit,
    onTap,
  });

  const on = value > 0;

  return (
    <div
      class={`next-shade-bar${unconfirmed ? ' is-unconfirmed' : ''}`}
      onPointerDown={gesture.onPointerDown}
      onPointerMove={gesture.onPointerMove}
      onPointerUp={gesture.onPointerUp}
      onPointerCancel={gesture.onPointerCancel}
    >
      <div aria-hidden="true" class="next-shade-bar-fill" style={{ width: `${value}%` }} />
      <div class="next-shade-bar-row">
        <span aria-hidden="true" class={`next-shade-dot${on ? ' is-on' : ''}`} />
        <span class="next-shade-bar-label">{label}</span>
        <span class="next-shade-bar-value">{statusText}</span>
      </div>
    </div>
  );
}

function ShadeCard({ entry }) {
  const view = commands.deviceView(entry);
  const live = (entry && entry.live) || {};
  const dimmedOut = view.reachable === false || view.stale;

  return (
    <div class={`next-shade-card${dimmedOut ? ' is-dimmed' : ''}`}>
      <div class="next-shade-card-header">
        <span class="next-shade-name">{view.title}</span>
        <span class="next-shade-status">{statusLabel(view.position, live.moving)}</span>
      </div>

      <div class="next-shade-groupactions">
        <button
          type="button"
          class="next-shade-action-btn"
          aria-label={`Open all shades in ${view.title}`}
          onClick={() => commands.openAllShades(entry)}
        >
          Open all
        </button>
        <button
          type="button"
          class="next-shade-action-btn"
          aria-label={`Close all shades in ${view.title}`}
          onClick={() => commands.closeAllShades(entry)}
        >
          Close all
        </button>
      </div>

      <PositionBar
        label="All shades"
        value={view.position}
        statusText={statusLabel(view.position, live.moving)}
        unconfirmed={view.unconfirmed}
        onPreview={(val) => commands.previewPosition(entry, val)}
        onCommit={(val) => commands.commitPosition(entry, val)}
        onTap={() => commands.toggleShade(entry)}
      />

      <div class="next-shade-individuals">
        {SHADES.map((shade) => {
          const position = commands.positionOfShade(entry, shade.key);
          const value = position == null ? 0 : position;
          const movingShades = live.movingShades || [];
          const shadeMoving = live.moving && movingShades.includes(shade.key) ? live.moving : null;
          return (
            <PositionBar
              key={shade.key}
              label={shade.label}
              value={value}
              statusText={statusLabel(position, shadeMoving)}
              onPreview={(val) => commands.previewShadePosition(entry, shade.key, val)}
              onCommit={(val) => commands.commitShadePosition(entry, shade.key, val)}
              onTap={() => commands.toggleShadeOne(entry, shade.key)}
            />
          );
        })}
      </div>

      <div class="next-shade-hint" aria-hidden="true">
        tap a bar to toggle · hold + drag to set a level
      </div>
    </div>
  );
}

export default function ShadesTab() {
  const selectedRoom = ui.selectedRoom.value;

  if (!selectedRoom) {
    return <div class="next-empty">Tap a room to control it</div>;
  }

  const entries = store.devicesInZoneOrRoom(selectedRoom)
    .filter((entry) => commands.kindOf(entry) === 'shade');

  if (entries.length === 0) {
    return <div class="next-empty">No shades in this room</div>;
  }

  return (
    <div class="next-shades-tab">
      {entries.map((entry) => (
        <ShadeCard key={entry.stateTopic || entry.id} entry={entry} />
      ))}
    </div>
  );
}
