// Apollo v2 dashboard -- reactive store (increment-1 state layer).
//
// Built on @preact/signals. Preact's signals integration re-renders any
// function component that reads a signal's `.value` during render, with no
// extra hooks required -- so components can just read e.g. `devices.value`
// directly. Every signal here holds an *immutable* value (a fresh Map/array/
// object on every update); mutating a Map/array in place would not notify
// subscribers, since signals compare by reference.
//
// Shape:
//   devices      Map<stateTopic, DeviceEntry>  -- keyed by the canonical MQTT
//                state topic, NOT the device id (a room can hold entries from
//                lights.json and devices.json, whose ids aren't guaranteed
//                unique across the two files, but stateTopic is).
//     DeviceEntry = {
//       ...listEntry,        // id, title, type, room, stateTopic, etc. from
//                             // /list/lights or /list/devices
//       live: { power?, brightness?, position?, color?, reachable? },
//       pending: { patch, previousLive, deadline } | undefined,
//       stale: boolean,       // from apollo/health/summary's `stale` array
//       lastSeenMs: number | undefined,
//       unconfirmed: boolean, // sticky flag: last optimistic patch reverted
//     }
//   rooms         Array<RoomEntry>              -- from /list/rooms, as-is
//   scenes        Map<id, { ...entry, active }> -- lightingScenes
//   macros        Map<id, { ...entry, active }>
//   deviceScenes  Array<entry>                  -- stateless, from /list/deviceScenes
//   spotify       object | null                 -- latest now-playing payload
//   connection    'connecting' | 'live' | 'polling' | 'offline'
//   bridges       { [bridgeName]: 'online' | 'offline' }
//   degraded      boolean
//
// This module intentionally has no MQTT/HTTP knowledge -- see mqtt.js,
// bootstrap.js, optimistic.js for the pieces that populate it.

import { signal } from '@preact/signals';

export const devices = signal(new Map());
export const rooms = signal([]);
export const scenes = signal(new Map());
export const macros = signal(new Map());
export const deviceScenes = signal([]);
export const spotify = signal(null);
export const connection = signal('connecting');
export const bridges = signal({});
export const degraded = signal(false);

/**
 * @param {string} stateTopic
 * @returns {object|null}
 */
export function deviceByStateTopic(stateTopic) {
  return devices.value.get(stateTopic) || null;
}

/**
 * @param {string} roomId
 * @returns {Array<object>}
 */
export function devicesInRoom(roomId) {
  const out = [];
  for (const entry of devices.value.values()) {
    if (entry.room === roomId) {
      out.push(entry);
    }
  }
  return out;
}

/**
 * Total device count -- used by the increment-1 status line.
 * @returns {number}
 */
export function deviceCount() {
  return devices.value.size;
}

/**
 * Replaces the whole devices map, keyed by each entry's `stateTopic`. Used at
 * bootstrap and by the polling fallback.
 * @param {Array<object>} entries - already carrying `live`/`stale`/etc fields
 */
export function setDevices(entries) {
  const map = new Map();
  for (const entry of entries) {
    map.set(entry.stateTopic, entry);
  }
  devices.value = map;
}

/**
 * Immutable read-modify-write for a single device entry. Creates a fresh Map
 * so signal subscribers are notified. If no entry exists yet for this topic
 * (e.g. a retained MQTT message arrives for a device not in any /list/*
 * response), a minimal stub entry is created rather than dropping the
 * message.
 * @param {string} stateTopic
 * @param {(existing: object) => object} patcher
 */
export function updateDevice(stateTopic, patcher) {
  const map = new Map(devices.value);
  const existing = map.get(stateTopic) || {
    stateTopic,
    live: {},
    stale: false,
    unconfirmed: false,
  };
  map.set(stateTopic, patcher(existing));
  devices.value = map;
}

/**
 * Replaces the scenes or macros map from a /list/lightingScenes or
 * /list/macros response, defaulting `active: false` (the real value arrives
 * over MQTT shortly after, or is left false if the broker is unreachable).
 * @param {import('@preact/signals').Signal<Map<string, object>>} collectionSignal
 * @param {Array<object>} entries
 */
export function setScenes(collectionSignal, entries) {
  const map = new Map();
  for (const entry of entries) {
    map.set(entry.id, { ...entry, active: false });
  }
  collectionSignal.value = map;
}

/**
 * Immutable read-modify-write for a single scene/macro entry, keyed by id.
 * @param {import('@preact/signals').Signal<Map<string, object>>} collectionSignal
 * @param {string} id
 * @param {(existing: object) => object} patcher
 */
export function updateScene(collectionSignal, id, patcher) {
  const map = new Map(collectionSignal.value);
  const existing = map.get(id) || {};
  map.set(id, patcher(existing));
  collectionSignal.value = map;
}
