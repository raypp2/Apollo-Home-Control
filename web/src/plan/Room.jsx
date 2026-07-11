// Apollo v2 dashboard -- isometric plane room rect.
//
// Absolute-positioned within the 470x980 plane using the room's own `rect`.
// Selection, occupancy glow, and the selectable/fixed (context-only) split
// all read live signals, so a room re-renders on its own whenever the
// relevant slice of state changes -- no prop drilling of derived booleans
// from Plane.
//
// Rooms sharing a `zone` (rooms.json's open-plan grouping -- kitchen/dining/
// living/office) render WITHOUT their own background/border/selected-overlay
// or room-level GlowLayer: that whole surface -- outline, fill, selected
// glow, and every member's fixture glow -- is drawn once at the plane level
// by ZoneOutline / GlowLayer's ZoneGlowLayer (see Plane.jsx), spanning the
// union of the members' rects with no interior wall between them. A zoned
// Room still owns click handling, furniture, fixture dots, and its label --
// it's just visually transparent where the zone layer already painted.

import { store, ui, commands } from '../state/index.js';
import Furniture from './Furniture.jsx';
import Fixture from './Fixture.jsx';
import GlowLayer from './GlowLayer.jsx';
import { flattenFixtures } from './fixtures.js';

/**
 * @param {{ room: object }} props
 */
export default function Room({ room }) {
  const selectable = room.selectable !== false;
  const zoned = !!room.zone;
  // A zoned room's tap resolves to its zone id (ui.selectRoom), so every
  // member selects together -- compare against that, not just room.id.
  const selected = ui.selectedRoom.value === (room.zone || room.id);

  // Every fixture position renders its own glow via GlowLayer -- directional
  // beam when the position has an `aim`, 360deg pool at the dot otherwise.
  // The centered room wash survives only as a fallback for devices that are
  // on but have no dot on the plan, so the two effects never double up.
  const flat = flattenFixtures(room.fixtures);
  const dottedDeviceIds = new Set(flat.map((f) => f.deviceId));

  const entries = store.devicesInRoom(room.id);
  let undottedOn = 0;
  for (const entry of entries) {
    if (dottedDeviceIds.has(entry.id)) continue;
    // Lights only: an open shade also reports on (position > 0), and it
    // shouldn't wash the room in lamplight.
    const view = commands.deviceView(entry);
    if ((view.kind === 'dim' || view.kind === 'switch') && view.on) undottedOn += 1;
  }
  // Zoned rooms skip this too -- a rectangular per-room wash would show a
  // seam at the (invisible) member boundary, breaking the one-surface look
  // the zone glow layer already provides.
  const glowOpacity = !zoned && undottedOn > 0 ? Math.min(0.25 + undottedOn * 0.13, 0.8) : 0;

  const style = {
    left: `${room.rect.x}px`,
    top: `${room.rect.y}px`,
    width: `${room.rect.w}px`,
    height: `${room.rect.h}px`,
  };

  const classNames = ['plan-room', selectable ? 'plan-room--selectable' : 'plan-room--fixed'];
  if (zoned) classNames.push('plan-room--zoned');
  if (selected && !zoned) classNames.push('plan-room--selected');

  return (
    <div
      class={classNames.join(' ')}
      style={style}
      onClick={selectable ? () => ui.selectRoom(room.id) : undefined}
    >
      {glowOpacity > 0 && (
        <div class="plan-room__glow" style={{ opacity: glowOpacity }} />
      )}

      {!zoned && flat.length > 0 && (
        <GlowLayer room={room} fixtures={flat} />
      )}

      {(room.furniture || []).map((item, i) => (
        <Furniture key={i} item={item} />
      ))}

      {flat.map(({ deviceId, pos, key }) => (
        <Fixture key={key} deviceId={deviceId} pos={pos} room={room} />
      ))}

      <div class="plan-room__label">{room.label}</div>

      {selected && !zoned && <div class="plan-room__selected-overlay" />}
    </div>
  );
}
