// Apollo v2 dashboard -- shared fixture-position helper.
//
// A fixture's value in room.fixtures is either a single {x,y} or an array of
// them (e.g. the primary bedroom's "bedroomColor", which gets a dot on each
// nightstand lamp but both dots reflect/control the one device). Flatten
// room.fixtures into one dot per position, all bound to the same deviceId,
// with stable per-position keys.
//
// Shared by Room.jsx (per-room dots + glow) and GlowLayer.jsx's zone glow
// layer (which walks every member room's fixtures too) -- pulled out here
// rather than exported from Room.jsx so GlowLayer.jsx importing it doesn't
// create a Room <-> GlowLayer circular import.

/**
 * @param {object} fixtures
 * @returns {Array<{ deviceId: string, pos: {x:number,y:number}, key: string }>}
 */
export function flattenFixtures(fixtures) {
  return Object.entries(fixtures || {}).flatMap(([deviceId, value]) => {
    const positions = Array.isArray(value) ? value : [value];
    return positions.map((pos, i) => ({ deviceId, pos, key: `${deviceId}-${i}` }));
  });
}
