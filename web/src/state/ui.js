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
 * Select a room (tapping it on the plane, or programmatically). Resolves a
 * zone-member room to its zone id first (see `selectedRoom` doc), so callers
 * can keep passing the tapped room's own id regardless of zone membership.
 * Passing the already-selected room id is a no-op-friendly re-set; pass null
 * to clear.
 * @param {string|null} roomId
 */
export function selectRoom(roomId) {
  if (roomId == null) {
    selectedRoom.value = null;
    return;
  }
  const room = rooms.value.find((r) => r.id === roomId);
  selectedRoom.value = (room && room.zone) || roomId;
}

/**
 * Record a last-action trace string, e.g. "Couch → 45%" or "Kitchen on".
 * Every command dispatch calls this so the status strip echoes it.
 * @param {string} text
 */
export function setLastAction(text) {
  lastAction.value = text;
}
