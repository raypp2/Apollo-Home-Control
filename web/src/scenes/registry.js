// Apollo v2 dashboard -- scene/macro bar tiering (increment 3; see
// documentation/dashboard-redesign-plan.md §4.2 "Tiered scene model").
//
// Single source of truth for which lightingScene/macro ids appear in which
// tier, so SceneBar/MoreMenu/RoomSceneBar stay data-driven instead of
// hard-coding JSX per entry.
//
// Collision rule, applied by omission: when a lightingScene and a macro share
// a title, only the macro is reachable from the UI (Bedtime, Away, Movie
// Mode) -- the scene id of that same title is simply never listed anywhere
// in this file. Room-scoped scenes (livingRoom, office), Accent-device
// scenes (wolf, mirrorball, dmxManual -- live in the panel's Accent drill-in,
// not owned by this directory), and the hidden keypad-blink helpers
// (button-a, button-b) are likewise intentionally absent from every tier
// below.

/** Default-visible top-bar cluster, in display order. */
export const DEFAULT_ENTRIES = [
  { kind: 'scene', id: 'hangoutMode' },
  { kind: 'scene', id: 'allLights' },
  { kind: 'macro', id: 'bedtimeMacro' },
  { kind: 'macro', id: 'studioMacro' },
  { kind: 'macro', id: 'raysMusic' },
];

/** Consolidated "..." overflow -- scenes and macros in one list, per Ray. */
export const MORE_ENTRIES = [
  { kind: 'macro', id: 'awayMacro' },
  { kind: 'macro', id: 'movieMode' },
];

/** roomId -> the single room-scoped scene entry shown atop that room's panel. */
export const ROOM_SCENES = {
  living: { kind: 'scene', id: 'livingRoom' },
  office: { kind: 'scene', id: 'office' },
};

/**
 * Panel device groups: consolidate a few individually-configured devices into
 * one expandable row in the room command panel (RoomPanel/GroupRow), rather
 * than each showing as its own DeviceRow. `members` lists the underlying
 * device ids in display order; the group row replaces them at the position
 * of whichever member appears first in the room's device list. `room` is the
 * plain room id the group belongs to (used to place it within the right
 * zone-member section on a shared zone panel).
 */
export const DEVICE_GROUPS = [
  { id: 'studio', title: 'Studio', room: 'office', members: ['webcam', 'hair-light'] },
];

/**
 * ROOM_SCENES entries for a zone's member rooms, in member order. A "common"
 * zone (kitchen/dining/living/office) spans multiple ROOM_SCENES entries
 * (living, office today) -- the zone panel shows all of them as presets
 * within the shared space, rather than picking just one the way a plain
 * room's panel would.
 * @param {Array<{id:string}>} members - ordered room objects, e.g. from
 *   store.zoneMembers(zoneId)
 * @returns {Array<{kind:'scene'|'macro', id:string}>}
 */
export function roomScenesForZone(members) {
  return members.map((room) => ROOM_SCENES[room.id]).filter(Boolean);
}

/**
 * Looks up a tier entry's live store record by kind+id. Takes the two Maps
 * as arguments (rather than reading store.scenes.value/store.macros.value
 * itself) so callers read the signals once in their own render and stay
 * subscribed to changes -- this function itself is a plain, non-reactive read.
 * @param {'scene'|'macro'} kind
 * @param {string} id
 * @param {Map<string,object>} scenesMap - store.scenes.value
 * @param {Map<string,object>} macrosMap - store.macros.value
 * @returns {object|null}
 */
export function resolveEntry(kind, id, scenesMap, macrosMap) {
  const map = kind === 'macro' ? macrosMap : scenesMap;
  return map.get(id) || null;
}
