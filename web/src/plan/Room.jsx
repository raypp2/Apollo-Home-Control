// Apollo v2 dashboard -- isometric plane room rect.
//
// Absolute-positioned within the 470x980 plane using the room's own `rect`.
// Selection, occupancy glow, and the selectable/fixed (context-only) split
// all read live signals, so a room re-renders on its own whenever the
// relevant slice of state changes -- no prop drilling of derived booleans
// from Plane.

import { store, ui, commands } from '../state/index.js';
import Furniture from './Furniture.jsx';
import Fixture from './Fixture.jsx';

/**
 * @param {{ room: object }} props
 */
export default function Room({ room }) {
  const selectable = room.selectable !== false;
  const selected = ui.selectedRoom.value === room.id;

  const entries = store.devicesInRoom(room.id);
  let lightsOn = 0;
  for (const entry of entries) {
    if (commands.deviceView(entry).on) lightsOn += 1;
  }
  const glowOpacity = lightsOn > 0 ? Math.min(0.25 + lightsOn * 0.13, 0.8) : 0;

  const style = {
    left: `${room.rect.x}px`,
    top: `${room.rect.y}px`,
    width: `${room.rect.w}px`,
    height: `${room.rect.h}px`,
  };

  const classNames = ['plan-room', selectable ? 'plan-room--selectable' : 'plan-room--fixed'];
  if (selected) classNames.push('plan-room--selected');

  return (
    <div
      class={classNames.join(' ')}
      style={style}
      onClick={selectable ? () => ui.selectRoom(room.id) : undefined}
    >
      {glowOpacity > 0 && (
        <div class="plan-room__glow" style={{ opacity: glowOpacity }} />
      )}

      {(room.furniture || []).map((item, i) => (
        <Furniture key={i} item={item} />
      ))}

      {Object.entries(room.fixtures || {}).map(([deviceId, pos]) => (
        <Fixture key={deviceId} deviceId={deviceId} pos={pos} room={room} />
      ))}

      <div class="plan-room__label">{room.label}</div>

      {selected && <div class="plan-room__selected-overlay" />}
    </div>
  );
}
