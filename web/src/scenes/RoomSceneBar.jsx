// Apollo v2 dashboard -- room-scoped scene bar (increment 3).
//
// Meant to sit at the top of the room command panel (the orchestrator wires
// the actual placement; this file only renders standalone and reads
// `ui.selectedRoom` for itself). Per the tiered model only 'living' and
// 'office' carry a room-scoped scene today (registry.ROOM_SCENES); every
// other room renders nothing.

import { ui, store } from '../state/index.js';
import { ROOM_SCENES, resolveEntry } from './registry.js';
import { SceneMacroButton } from './Button.jsx';
import './scenes.css';

export default function RoomSceneBar() {
  const roomId = ui.selectedRoom.value;
  const mapping = roomId && ROOM_SCENES[roomId];
  if (!mapping) return null;

  const scenesMap = store.scenes.value;
  const macrosMap = store.macros.value;
  const entry = resolveEntry(mapping.kind, mapping.id, scenesMap, macrosMap);
  if (!entry) return null;

  return (
    <div class="room-scene-bar">
      <SceneMacroButton kind={mapping.kind} entry={entry} />
    </div>
  );
}

export { RoomSceneBar };
