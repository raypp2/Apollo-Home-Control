// Apollo v2 dashboard -- UI-only signals shared across surfaces.
//
// These are ephemeral view concerns (which room is selected, the last-action
// trace shown in the status strip), deliberately separate from store.js, which
// holds device/system state hydrated from the backend. The isometric plane and
// the command panel both read/write `selectedRoom`; every command path writes
// `lastAction`.

import { signal } from '@preact/signals';

/** Currently selected room id (matches a rooms[].id), or null when none. */
export const selectedRoom = signal(null);

/** Human-readable trace of the most recent action, shown in the status strip. */
export const lastAction = signal('');

/**
 * Select a room (tapping it on the plane, or programmatically). Passing the
 * already-selected room id is a no-op-friendly re-set; pass null to clear.
 * @param {string|null} roomId
 */
export function selectRoom(roomId) {
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
