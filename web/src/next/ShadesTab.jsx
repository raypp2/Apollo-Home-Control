// Apollo "next" preview layout -- Shades tab: the selected room/zone's Somfy
// shade entries, rendered with the existing ShadeRow (which owns its own
// ShadeDrillIn behind its '>' chevron) -- no reimplementation needed here.

import { store, ui, commands } from '../state/index.js';
import ShadeRow from '../panel/ShadeRow.jsx';

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
        <ShadeRow key={entry.stateTopic || entry.id} entry={entry} />
      ))}
    </div>
  );
}
