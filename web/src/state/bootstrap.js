// Apollo v2 dashboard -- bootstrap sequence + polling fallback.
//
// bootstrap() is the one entry point main.jsx calls on mount:
//   1. Fetch the initial snapshot over HTTP (health + every /list/*).
//   2. Build the store from it.
//   3. Open the MQTT connection for live updates.
//   4. If MQTT hasn't reached 'live' within a few seconds, start polling the
//      same HTTP endpoints on an interval as a fallback -- this mirrors the
//      old AngularJS dashboard's polling behavior for environments with no
//      reachable broker (e.g. a dev Mac with no Mosquitto on :9001).
//
// Polling stops automatically the moment `connection` becomes 'live' (an
// effect below watches for it), so a broker that comes up later takes back
// over without a page reload.

import { effect } from '@preact/signals';
import * as store from './store.js';
import { getHealth, getList } from './api.js';
import { connect as connectMqtt } from './mqtt.js';

const MQTT_CONNECT_GRACE_MS = 3000;
const POLL_INTERVAL_MS = 5000;

let pollTimer = null;

/**
 * Joins /list/lights + /list/devices (each entry already carries a
 * `stateTopic`) with /api/health's `deviceDetail` (per-topic last state +
 * staleness) into the DeviceEntry shape store.js expects.
 * @param {Array<object>} lights
 * @param {Array<object>} devicesList
 * @param {Array<object>} deviceDetail - health.deviceDetail
 * @returns {Array<object>}
 */
function joinDeviceLists(lights, devicesList, deviceDetail) {
  const detailByTopic = new Map(deviceDetail.map((d) => [d.topic, d]));

  // Tag each entry with the /api command module it dispatches to, so the
  // command layer (state/commands.js) doesn't have to re-infer it from `type`.
  const tagged = [
    ...lights.map((e) => ({ ...e, module: 'LIGHTS' })),
    ...devicesList.map((e) => ({ ...e, module: 'DEVICES' })),
  ];

  return tagged.map((entry) => {
    const detail = detailByTopic.get(entry.stateTopic);
    return {
      ...entry,
      live: (detail && detail.state && typeof detail.state === 'object') ? detail.state : {},
      stale: Boolean(detail && detail.stale),
      lastSeenMs: detail ? detail.lastSeenMs : undefined,
      unconfirmed: false,
    };
  });
}

/**
 * One HTTP poll cycle: re-fetch lights/devices/health and reconcile into the
 * existing store, preserving any outstanding optimistic `pending` state
 * (a poll snapshot must not clobber an in-flight optimistic command any more
 * violently than a stale MQTT message would). Also re-fetches
 * lightingScenes/macros so a client with no live MQTT connection still
 * converges on backend truth for externally-activated (e.g. Alexa) scenes.
 */
async function pollOnce() {
  const [lights, devicesList, health] = await Promise.all([
    getList('lights'),
    getList('devices'),
    getHealth(),
  ]);

  // Scene/macro refresh is best-effort and separate from the device poll
  // above -- a failure here must not stop device state from updating.
  try {
    const [lightingScenes, macros] = await Promise.all([
      getList('lightingScenes'),
      getList('macros'),
    ]);
    store.setScenes(store.scenes, lightingScenes);
    store.setScenes(store.macros, macros);
  } catch (err) {
    console.warn('[apollo] poll cycle: scene/macro refresh failed:', err.message);
  }

  const detailByTopic = new Map((health.deviceDetail || []).map((d) => [d.topic, d]));
  const map = new Map(store.devices.value);

  const tagged = [
    ...lights.map((e) => ({ ...e, module: 'LIGHTS' })),
    ...devicesList.map((e) => ({ ...e, module: 'DEVICES' })),
  ];
  for (const entry of tagged) {
    const detail = detailByTopic.get(entry.stateTopic);
    const existing = map.get(entry.stateTopic);
    const polledLive = (detail && detail.state && typeof detail.state === 'object') ? detail.state : {};

    map.set(entry.stateTopic, {
      ...entry,
      live: existing ? { ...existing.live, ...polledLive } : polledLive,
      stale: Boolean(detail && detail.stale),
      lastSeenMs: detail ? detail.lastSeenMs : (existing && existing.lastSeenMs),
      pending: existing && existing.pending,
      unconfirmed: existing ? existing.unconfirmed : false,
    });
  }

  store.devices.value = map;
  store.bridges.value = { ...health.bridges };
  store.degraded.value = Boolean(health.degraded);
}

function startPolling() {
  if (pollTimer) {
    return;
  }
  store.connection.value = 'polling';
  pollTimer = setInterval(() => {
    pollOnce().catch((err) => {
      // Transient fetch failure during polling -- keep showing last-known
      // state and let the next tick retry, rather than clearing the store.
      console.warn('[apollo] poll cycle failed:', err.message);
    });
  }, POLL_INTERVAL_MS);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

// Reactive, rather than tied to the poll interval's own cadence: the moment
// mqtt.js flips `connection` to 'live' (including well after the initial
// grace period, if a broker comes up late), stop polling immediately instead
// of waiting up to POLL_INTERVAL_MS for the next tick to notice.
effect(() => {
  if (store.connection.value === 'live') {
    stopPolling();
  }
});

/**
 * Runs the full bootstrap sequence described in the module doc comment.
 * @returns {Promise<void>}
 */
export async function bootstrap() {
  const [health, lights, devicesList, rooms, lightingScenes, macros, deviceScenes] = await Promise.all([
    getHealth(),
    getList('lights'),
    getList('devices'),
    getList('rooms'),
    getList('lightingScenes'),
    getList('macros'),
    getList('deviceScenes'),
  ]);

  store.setDevices(joinDeviceLists(lights, devicesList, health.deviceDetail || []));
  store.rooms.value = rooms;
  store.deviceScenes.value = deviceScenes;
  store.setScenes(store.scenes, lightingScenes);
  store.setScenes(store.macros, macros);
  store.bridges.value = { ...health.bridges };
  store.degraded.value = Boolean(health.degraded);

  // Best-effort: not every deploy has this endpoint yet, and nothing consumes
  // `prefs` yet either -- just hydrate quietly, no user-visible failure.
  try {
    const prefsResponse = await fetch('/api/prefs');
    store.prefs.value = prefsResponse.ok ? (await prefsResponse.json()) || {} : {};
  } catch {
    store.prefs.value = {};
  }

  connectMqtt();

  setTimeout(() => {
    if (store.connection.value !== 'live') {
      startPolling();
    }
  }, MQTT_CONNECT_GRACE_MS);
}
