// Apollo v2 dashboard -- live MQTT-over-WebSocket transport.
//
// Connects to the Mosquitto websockets listener on the same host, port 9001
// (plain ws -- the dashboard itself is served over http). This is the "live"
// half of the state layer; bootstrap.js owns the polling fallback for when no
// broker is reachable (a Mac dev box normally has none).
//
// Payload parsing mirrors src/mqttClient.js exactly: decode to a string,
// attempt JSON.parse, and if that throws keep the raw string -- health/bridge
// payloads are raw strings by design, everything else is JSON.

import mqtt from 'mqtt';
import * as store from './store.js';
import { patchMatches } from './optimistic.js';

const STATE_TOPIC_FILTER = 'apollo/+/+/+/state';
const HEALTH_TOPIC = 'apollo/health/summary';
const BRIDGE_TOPIC_FILTER = 'apollo/bridge/+/status';
const SCENE_TOPIC_FILTER = 'apollo/home/scene/+/state';
const MACRO_TOPIC_FILTER = 'apollo/home/macro/+/state';
const SPOTIFY_TOPIC = 'apollo/home/spotify/player/state';

const SUBSCRIPTIONS = [
  STATE_TOPIC_FILTER,
  HEALTH_TOPIC,
  BRIDGE_TOPIC_FILTER,
  SCENE_TOPIC_FILTER,
  MACRO_TOPIC_FILTER,
];

let client = null;

/**
 * Same wildcard-matching rule as src/mqttClient.js#topicMatches ('+' matches
 * one segment, '#' matches the rest). Duplicated here because the browser
 * talks to the broker directly -- there's no server-side topic filtering to
 * lean on client-side.
 * @param {string} filter
 * @param {string} topic
 * @returns {boolean}
 */
function topicMatches(filter, topic) {
  const filterParts = filter.split('/');
  const topicParts = topic.split('/');

  for (let i = 0; i < filterParts.length; i++) {
    const f = filterParts[i];
    if (f === '#') {
      return true;
    }
    if (i >= topicParts.length) {
      return false;
    }
    if (f === '+') {
      continue;
    }
    if (f !== topicParts[i]) {
      return false;
    }
  }
  return filterParts.length === topicParts.length;
}

/**
 * @param {string} raw
 * @returns {object|string}
 */
function parsePayload(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * apollo/+/+/+/state handler (device state + Spotify now-playing, which
 * matches the same 5-segment filter). Merges into `live` rather than
 * replacing it (a brightness-only message must not erase `power`), and
 * clears a pending optimistic patch only when the merged live value matches
 * it within tolerance -- see optimistic.js#patchMatches. If a pending patch
 * hasn't been confirmed yet, the fields it touches keep showing the
 * optimistic value rather than flickering to a possibly-stale intermediate
 * reading; every other field still updates normally.
 * @param {string} topic
 * @param {object|string} payload
 */
function handleDeviceState(topic, payload) {
  if (topic === SPOTIFY_TOPIC) {
    store.spotify.value = (payload && typeof payload === 'object') ? payload : null;
    return;
  }

  if (!payload || typeof payload !== 'object') {
    return; // malformed/non-JSON payload on a state topic -- ignore defensively
  }

  store.updateDevice(topic, (existing) => {
    const merged = { ...existing.live, ...payload };
    const pendingPatch = existing.pending && existing.pending.patch;

    if (!pendingPatch) {
      return { ...existing, live: merged, lastSeenMs: Date.now() };
    }

    if (patchMatches(pendingPatch, merged)) {
      return {
        ...existing,
        live: merged,
        pending: undefined,
        lastSeenMs: Date.now(),
      };
    }

    // Not yet confirmed -- keep showing the optimistic values for the
    // fields the pending patch touches, take everything else as-is.
    return {
      ...existing,
      live: { ...merged, ...pendingPatch },
      lastSeenMs: Date.now(),
    };
  });
}

/**
 * apollo/health/summary handler -- updates bridges/degraded and marks each
 * device's `stale` flag from the summary's `stale` topic list.
 * @param {object} payload
 */
function handleHealthSummary(payload) {
  if (!payload || typeof payload !== 'object') {
    return;
  }

  store.bridges.value = { ...payload.bridges };
  store.degraded.value = Boolean(payload.degraded);

  const staleSet = new Set(payload.stale || []);
  const map = new Map(store.devices.value);
  let changed = false;
  for (const [topic, entry] of map) {
    const stale = staleSet.has(topic);
    if (entry.stale !== stale) {
      map.set(topic, { ...entry, stale });
      changed = true;
    }
  }
  if (changed) {
    store.devices.value = map;
  }
}

/**
 * apollo/bridge/+/status handler -- raw 'online'/'offline' string payloads.
 * @param {string} topic
 * @param {string} payload
 */
function handleBridgeStatus(topic, payload) {
  if (payload !== 'online' && payload !== 'offline') {
    return; // unrecognized shape -- mirror healthMonitor.js's defensiveness
  }
  const parts = topic.split('/');
  const name = parts.length >= 3 ? parts[2] : topic;
  store.bridges.value = { ...store.bridges.value, [name]: payload };
}

/**
 * apollo/home/scene/+/state or apollo/home/macro/+/state handler.
 * @param {import('@preact/signals').Signal<Map<string, object>>} collectionSignal
 * @param {string} topic
 * @param {object} payload
 */
function handleSceneOrMacro(collectionSignal, topic, payload) {
  if (!payload || typeof payload !== 'object') {
    return;
  }
  const parts = topic.split('/');
  const id = parts.length >= 4 ? parts[3] : null;
  if (!id) {
    return;
  }
  store.updateScene(collectionSignal, id, (existing) => ({
    ...existing,
    ...payload,
    active: Boolean(payload.active),
  }));
}

/**
 * Routes one incoming message to the right handler by topic filter.
 * @param {string} topic
 * @param {string} raw
 */
function route(topic, raw) {
  const payload = parsePayload(raw);

  if (topic === HEALTH_TOPIC) {
    handleHealthSummary(payload);
    return;
  }
  if (topicMatches(BRIDGE_TOPIC_FILTER, topic)) {
    handleBridgeStatus(topic, payload);
    return;
  }
  if (topicMatches(SCENE_TOPIC_FILTER, topic)) {
    handleSceneOrMacro(store.scenes, topic, payload);
    return;
  }
  if (topicMatches(MACRO_TOPIC_FILTER, topic)) {
    handleSceneOrMacro(store.macros, topic, payload);
    return;
  }
  if (topicMatches(STATE_TOPIC_FILTER, topic)) {
    handleDeviceState(topic, payload);
    return;
  }
  // Unrecognized topic (shouldn't happen given our subscription list) --
  // silently ignored rather than thrown.
}

/**
 * Opens the websocket MQTT connection and subscribes to every topic filter
 * the state layer cares about. Idempotent -- a second call returns the
 * existing client rather than opening a duplicate connection.
 *
 * Robust to the broker being absent: mqtt.js's own `reconnectPeriod` keeps
 * retrying in the background (so a broker that comes up later is picked up
 * without a page reload), but this module never spins its own retry loop --
 * it only flips `connection` to 'polling' on error/close so bootstrap.js's
 * polling fallback can take over. `connection` flips back to 'live'
 * automatically if/when a 'connect' event does fire.
 * @returns {import('mqtt').MqttClient}
 */
export function connect() {
  if (client) {
    return client;
  }

  const url = `ws://${window.location.hostname}:9001`;
  client = mqtt.connect(url, {
    reconnectPeriod: 5000,
    connectTimeout: 4000,
  });

  client.on('connect', () => {
    store.connection.value = 'live';
    client.subscribe(SUBSCRIPTIONS, { qos: 1 }, (err) => {
      if (err) {
        // Subscription failure after a successful connect is unexpected but
        // non-fatal -- leave `connection` as 'live' (the socket is up) and
        // just note it for anyone watching devtools.
        console.warn('[apollo] mqtt subscribe failed:', err.message);
      }
    });
  });

  client.on('message', (topic, messageBuffer) => {
    route(topic, messageBuffer.toString());
  });

  client.on('error', (err) => {
    console.warn('[apollo] mqtt error (falling back to polling):', err && err.message);
    if (store.connection.value !== 'live') {
      store.connection.value = 'polling';
    }
  });

  client.on('close', () => {
    if (store.connection.value === 'live') {
      // Was live, dropped -- fall back to polling until (if ever) a future
      // 'connect' event flips this back.
      store.connection.value = 'polling';
    }
  });

  return client;
}

/**
 * Closes the connection, if any. Not used in normal operation (the page
 * lifetime IS the connection lifetime) -- exposed for completeness/tests.
 */
export function disconnect() {
  if (client) {
    client.end(true);
    client = null;
  }
}
