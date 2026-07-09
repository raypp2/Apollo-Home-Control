// Apollo v2 dashboard -- Room Command Panel (increment 2, extended in
// increment 3).
//
// Right column: shows a hint when no room is selected, otherwise the
// selected room's dimmable/switch/color/shade devices as a vertical list of
// rows. The 6 DMX fixture lights ('dmxFixture' type) are pulled out of that
// list and consolidated into a single AccentRow + its drill-in (increment 3).
// AV/climate/etc ('other' kind) are out of scope until increment 4 -- see
// commands.kindOf.

import { useEffect, useState } from 'preact/hooks';
import { store, ui, commands } from '../state/index.js';
import DeviceRow from './DeviceRow.jsx';
import ShadeRow from './ShadeRow.jsx';
import AccentRow from './AccentRow.jsx';
import AccentDrillIn from './AccentDrillIn.jsx';

const PANEL_KINDS = new Set(['dim', 'switch', 'color', 'shade']);
const FONT = "'Outfit', system-ui, sans-serif";

const PANEL_STYLE = {
  position: 'relative',
  width: 365,
  flexShrink: 0,
  boxSizing: 'border-box',
  borderLeft: '1px solid var(--hairline, rgba(234, 229, 239, 0.1))',
  background: 'var(--bg-panel, rgba(20, 17, 26, 0.7))',
  padding: '24px 26px',
  display: 'flex',
  flexDirection: 'column',
  height: '100dvh',
  overflowY: 'auto',
};

/** "KITCHEN" -> "Kitchen"; used only for display, ids stay as-is. */
function titleCase(label) {
  if (!label) return '';
  return label
    .toLowerCase()
    .split(' ')
    .map((word) => (word ? word[0].toUpperCase() + word.slice(1) : word))
    .join(' ');
}

function RoomPanel() {
  const selectedRoom = ui.selectedRoom.value;
  const [accentDrillInOpen, setAccentDrillInOpen] = useState(false);

  // Close the drill-in on room change so switching rooms never leaves a
  // stale overlay open over a different room's controls.
  useEffect(() => {
    setAccentDrillInOpen(false);
  }, [selectedRoom]);

  if (!selectedRoom) {
    return (
      <div style={PANEL_STYLE}>
        <div
          style={{
            margin: 'auto',
            textAlign: 'center',
            fontFamily: FONT,
            fontWeight: 400,
            fontSize: 15,
            color: 'rgba(234, 229, 239, 0.4)',
          }}
        >
          Tap a room to control it
        </div>
      </div>
    );
  }

  const room = store.rooms.value.find((r) => r.id === selectedRoom);
  const label = titleCase(room ? room.label : selectedRoom);

  const roomDevices = store.devicesInRoom(selectedRoom);
  const accentEntries = roomDevices.filter((entry) => entry.type === 'dmxFixture');
  const entries = roomDevices
    .filter((entry) => entry.type !== 'dmxFixture')
    .filter((entry) => PANEL_KINDS.has(commands.kindOf(entry)));

  return (
    <div style={PANEL_STYLE}>
      <div
        style={{
          fontFamily: FONT,
          fontWeight: 600,
          fontSize: 26,
          marginBottom: 18,
          flexShrink: 0,
        }}
      >
        {label}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
        {entries.map((entry) => {
          const kind = commands.kindOf(entry);
          const key = entry.stateTopic || entry.id;
          return kind === 'shade'
            ? <ShadeRow key={key} entry={entry} />
            : <DeviceRow key={key} entry={entry} />;
        })}
        {accentEntries.length > 0 && (
          <AccentRow
            entries={accentEntries}
            onShowControls={() => setAccentDrillInOpen(true)}
          />
        )}
      </div>

      <div
        style={{
          marginTop: 16,
          flexShrink: 0,
          fontFamily: FONT,
          fontWeight: 300,
          fontSize: 11,
          color: 'rgba(234, 229, 239, 0.32)',
        }}
      >
        tap to toggle · hold + drag to set a level
      </div>

      {accentDrillInOpen && accentEntries.length > 0 && (
        <AccentDrillIn
          accentEntries={accentEntries}
          onBack={() => setAccentDrillInOpen(false)}
        />
      )}
    </div>
  );
}

export default RoomPanel;
