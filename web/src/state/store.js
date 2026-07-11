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
//   rooms         Array<RoomEntry>              -- from /list/rooms, as-is.
//                 Some entries carry an optional `zone` id (e.g. "common")
//                 grouping open-plan rooms with no interior walls; see
//                 zoneMembers()/devicesInZoneOrRoom() below.
//   scenes        Map<id, { ...entry, active }> -- lightingScenes
//   macros        Map<id, { ...entry, active }>
//   deviceScenes  Array<entry>                  -- stateless, from /list/deviceScenes
//   spotify       object | null                 -- latest now-playing payload
//   connection    'connecting' | 'live' | 'polling' | 'offline'
//   bridges       { [bridgeName]: 'online' | 'offline' }
//   degraded      boolean
//   prefs         object                        -- from /api/prefs, e.g. custom swatches
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
// GET /api/prefs at bootstrap -- e.g. custom color swatches. Nothing consumes
// this yet; it's hydrated ahead of the feature that will read it.
export const prefs = signal({});

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
 * Ordered member rooms sharing a "common" zone id (rooms.json's `zone`
 * field -- an open-plan space with no interior walls, e.g. kitchen/dining/
 * living/office). Order follows rooms.json's array order, not insertion or
 * alphabetical order. Returns [] for a plain room id or an unknown id.
 * @param {string} zoneId
 * @returns {Array<object>}
 */
export function zoneMembers(zoneId) {
  return rooms.value.filter((r) => r.zone === zoneId);
}

/**
 * Devices for a room OR a zone. When `id` matches a zone id (any room's
 * `zone` field), returns the union of `devicesInRoom` for every member room,
 * in rooms.json member order, each room's own device order preserved within
 * that. Otherwise behaves exactly like `devicesInRoom(id)`.
 * @param {string} id - a room id or a zone id
 * @returns {Array<object>}
 */
export function devicesInZoneOrRoom(id) {
  const members = zoneMembers(id);
  if (members.length === 0) return devicesInRoom(id);
  const out = [];
  for (const member of members) {
    out.push(...devicesInRoom(member.id));
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
 * /list/macros response. `active` comes from the entry itself when the
 * backend supplies it (so an externally-activated scene/macro, e.g. via
 * Alexa, still shows as active for a client with no live MQTT connection);
 * it defaults to false when the field is absent. The real value also arrives
 * over MQTT shortly after, for clients that do have a live broker connection.
 * @param {import('@preact/signals').Signal<Map<string, object>>} collectionSignal
 * @param {Array<object>} entries
 */
export function setScenes(collectionSignal, entries) {
  const map = new Map();
  for (const entry of entries) {
    map.set(entry.id, { ...entry, active: Boolean(entry.active) });
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
