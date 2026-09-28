// Apollo "next" preview layout -- bottom sheet opened by a Tile's long-press
// or "›" corner (see Tile.jsx / LightsTab.jsx). One component handles all
// three tile kinds via `sheet.type`:
//   'device' -- a single light: power button, brightness bar (drag, mirrors
//               DeviceRow's gesture/commit-mode handling), ColorSwatches for
//               kind 'color'.
//   'group'  -- a DEVICE_GROUPS group: each member rendered as a compact
//               DeviceRow (reused as-is).
//   'accent' -- the folded DMX accent tile: renders the existing
//               AccentDrillIn content, unchanged.
//
// Renders above everything including the Dock (see next.css's z-index),
// with a scrim; tap the scrim, the close button, or Escape dismisses.

import { useEffect } from 'preact/hooks';
import { commands } from '../state/index.js';
import { useDragGesture } from '../panel/useDragGesture.js';
import DeviceRow from '../panel/DeviceRow.jsx';
import ColorSwatches from '../panel/ColorSwatches.jsx';
import AccentDrillIn from '../panel/AccentDrillIn.jsx';

function DeviceSheetBody({ entry }) {
  const view = commands.deviceView(entry);
  const isColor = view.kind === 'color';
  const isDim = view.kind === 'dim' || isColor;

  const gesture = useDragGesture({
    startValue: view.level,
    commitMode: view.commit,
    onPreview: (val) => commands.previewLevel(entry, val),
    onCommit: (val) => commands.commitLevel(entry, val),
    onTap: () => commands.toggle(entry),
  });

  return (
    <div class="tile-sheet-body">
      <div class="tile-sheet-title">{view.title}</div>
      <button
        type="button"
        class={`tile-sheet-power${view.on ? ' is-on' : ''}`}
        onClick={() => commands.toggle(entry)}
      >
        {view.on ? 'On' : 'Off'}
      </button>
      {isDim && (
        <div
          class="tile-sheet-bar"
          onPointerDown={gesture.onPointerDown}
          onPointerMove={gesture.onPointerMove}
          onPointerUp={gesture.onPointerUp}
          onPointerCancel={gesture.onPointerCancel}
        >
          <div aria-hidden="true" class="tile-sheet-bar-fill" style={{ width: `${view.level}%` }} />
          <span class="tile-sheet-bar-label">{view.on ? `${view.level}%` : 'Off'}</span>
        </div>
      )}
      {isColor && <ColorSwatches entry={entry} color={view.color} />}
    </div>
  );
}

function GroupSheetBody({ group, entries }) {
  return (
    <div class="tile-sheet-body">
      <div class="tile-sheet-title">{group.title}</div>
      <div class="tile-sheet-group-list">
        {entries.map((entry) => (
          <DeviceRow key={entry.stateTopic || entry.id} entry={entry} />
        ))}
      </div>
    </div>
  );
}

/**
 * @param {object} props
 * @param {null|{type:'device',entry:object}|{type:'group',group:object,entries:Array<object>}|{type:'accent',accentEntries:Array<object>}} props.sheet
 * @param {() => void} props.onClose
 */
function TileSheet({ sheet, onClose }) {
  useEffect(() => {
    if (!sheet) return undefined;
    function onKeyDown(event) {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [sheet, onClose]);

  if (!sheet) return null;

  return (
    <div class="tile-sheet-scrim" onClick={onClose}>
      <div class="tile-sheet" onClick={(event) => event.stopPropagation()}>
        <div class="tile-sheet-handle-row">
          <span aria-hidden="true" class="tile-sheet-handle" />
          <button type="button" class="tile-sheet-close" aria-label="Close" onClick={onClose}>
            &times;
          </button>
        </div>
        <div class="tile-sheet-scroll">
          {sheet.type === 'device' && <DeviceSheetBody entry={sheet.entry} />}
          {sheet.type === 'group' && <GroupSheetBody group={sheet.group} entries={sheet.entries} />}
          {sheet.type === 'accent' && (
            <div class="tile-sheet-accent">
              <AccentDrillIn accentEntries={sheet.accentEntries} onBack={onClose} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default TileSheet;
