// Apollo v2 dashboard -- UI-only signals shared across surfaces.
//
// These are ephemeral view concerns (which room is selected, the last-action
// trace shown in the status strip), deliberately separate from store.js, which
// holds device/system state hydrated from the backend. The isometric plane and
// the command panel both read/write `selectedRoom`; every command path writes
// `lastAction`.

import { signal } from '@preact/signals';
import { rooms } from './store.js';

/**
 * Currently selected room id, or null when none. When the tapped room
 * belongs to a "common" zone (an open-plan space with no interior walls --
 * see rooms.json's `zone` field), this holds the ZONE id instead of the
 * member room id, so every member room lights up as selected and one shared
 * panel covers the whole space. Plain rooms (no `zone`) store their own id
 * as always.
 */
export const selectedRoom = signal(null);

/** Human-readable trace of the most recent action, shown in the status strip. */
export const lastAction = signal('');

/**
 * The most recently tapped ZONE MEMBER room, e.g. `{ roomId: 'kitchen', ts:
 * 169... }`. Set by `selectRoom` whenever the tapped room resolves to a zone
 * (see `selectedRoom` doc) -- `ts` always advances, even on a re-tap of the
 * same member, so RoomPanel's effect fires again to re-trigger the scroll +
 * flash. Consumed by RoomPanel to scroll that member's device rows into view
 * and flash them (useful on mobile, where the shared zone panel can hold more
 * device rows than fit on screen at once). null until the first zone-member
 * tap of the session.
 */
export const focusRoom = signal(null);

/**
 * Select a room (tapping it on the plane, or programmatically). Resolves a
 * zone-member room to its zone id first (see `selectedRoom` doc), so callers
 * can keep passing the tapped room's own id regardless of zone membership --
 * and, when it does resolve to a zone, records the tap in `focusRoom` so the
 * panel can scroll/flash that member's section. Passing the already-selected
 * room id is a no-op-friendly re-set; pass null to clear.
 * @param {string|null} roomId
 */
export function selectRoom(roomId) {
  if (roomId == null) {
    selectedRoom.value = null;
    return;
  }
  const room = rooms.value.find((r) => r.id === roomId);
  if (room && room.zone) {
    selectedRoom.value = room.zone;
    focusRoom.value = { roomId: room.id, ts: Date.now() };
    return;
  }
  selectedRoom.value = roomId;
}

/**
 * Record a last-action trace string, e.g. "Couch → 45%" or "Kitchen on".
 * Every command dispatch calls this so the status strip echoes it.
 * @param {string} text
 */
export function setLastAction(text) {
  lastAction.value = text;
}
