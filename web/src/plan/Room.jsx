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
import GlowLayer from './GlowLayer.jsx';

/**
 * A fixture's value in room.fixtures is either a single {x,y} or an array of
 * them (e.g. the primary bedroom's "bedroomColor", which gets a dot on each
 * nightstand lamp but both dots reflect/control the one device). Flatten
 * room.fixtures into one dot per position, all bound to the same deviceId,
 * with stable per-position keys.
 * @param {object} fixtures
 * @returns {Array<{ deviceId: string, pos: {x:number,y:number}, key: string }>}
 */
function flattenFixtures(fixtures) {
  return Object.entries(fixtures || {}).flatMap(([deviceId, value]) => {
    const positions = Array.isArray(value) ? value : [value];
    return positions.map((pos, i) => ({ deviceId, pos, key: `${deviceId}-${i}` }));
  });
}

/**
 * @param {{ room: object }} props
 */
export default function Room({ room }) {
  const selectable = room.selectable !== false;
  const selected = ui.selectedRoom.value === room.id;

  // Fixture positions carrying an `aim` render their own directional glow
  // via GlowLayer; their devices are excluded from the centered room wash so
  // the two effects don't double up.
  const flat = flattenFixtures(room.fixtures);
  const aimedFixtures = flat.filter((f) => f.pos.aim != null);
  const aimedDeviceIds = new Set(aimedFixtures.map((f) => f.deviceId));

  const entries = store.devicesInRoom(room.id);
  let lightsOn = 0;
  for (const entry of entries) {
    if (aimedDeviceIds.has(entry.id)) continue;
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

      {aimedFixtures.length > 0 && (
        <GlowLayer room={room} fixtures={aimedFixtures} />
      )}

      {(room.furniture || []).map((item, i) => (
        <Furniture key={i} item={item} />
      ))}

      {flat.map(({ deviceId, pos, key }) => (
        <Fixture key={key} deviceId={deviceId} pos={pos} room={room} />
      ))}

      <div class="plan-room__label">{room.label}</div>

      {selected && <div class="plan-room__selected-overlay" />}
    </div>
  );
}
