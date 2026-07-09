// Apollo v2 dashboard -- optimistic command state + reconciliation.
//
// Commands are fire-and-forget HTTP POSTs (see api.js#sendCommand); the only
// confirmation is a later retained MQTT state message. This module lets the
// UI show the *intended* result immediately, then either confirms it (mqtt.js
// calls back into here indirectly via patchMatches, see below) or reverts it
// if nothing confirms within a deadline.
//
// Device-class exception: entries whose config `type` is `dmxFixture` or
// `wled` never publish MQTT state at all (see src/mqttTopics.js's
// ALEXA_STATEFUL_TYPES comment -- wled/dmx are deliberately excluded from the
// stateful set because they don't publish state yet). For those, there is
// nothing to reconcile against, ever, so the optimistic value IS the state:
// no deadline, no revert, no `unconfirmed` flag.

import * as store from './store.js';

const DEFAULT_DEADLINE_MS = 4000;
const TOLERANCE = 3; // brightness/position agreement tolerance, in percent

// Config `type` values that never publish MQTT state (see module doc above).
const NEVER_CONFIRMS_TYPES = new Set(['dmxFixture', 'wled']);

function withinTolerance(a, b) {
  return typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= TOLERANCE;
}

/**
 * Does `live` satisfy every field of an outstanding optimistic `patch`?
 * brightness/position compare with tolerance (MQTT round-trips can settle a
 * point or two off the requested value); everything else compares exactly.
 * Exported so mqtt.js can use the identical rule when deciding whether an
 * incoming state message confirms a pending optimistic patch.
 * @param {object} patch
 * @param {object} live
 * @returns {boolean}
 */
export function patchMatches(patch, live) {
  return Object.keys(patch).every((key) => {
    if (key === 'brightness' || key === 'position') {
      return withinTolerance(patch[key], live[key]);
    }
    return patch[key] === live[key];
  });
}

/**
 * @param {string} type - a /list/lights or /list/devices entry's `type` field
 * @returns {boolean}
 */
export function neverConfirms(type) {
  return NEVER_CONFIRMS_TYPES.has(type);
}

function scheduleRevert(stateTopic, deadline) {
  setTimeout(() => {
    store.updateDevice(stateTopic, (existing) => {
      // Already confirmed (mqtt.js cleared `pending`) or superseded by a
      // newer optimistic command against the same device -- nothing to do.
      if (!existing.pending || existing.pending.deadline !== deadline) {
        return existing;
      }
      return {
        ...existing,
        live: { ...existing.live, ...existing.pending.previousLive },
        pending: undefined,
        unconfirmed: true,
      };
    });
  }, DEFAULT_DEADLINE_MS);
}

/**
 * Applies an optimistic command result immediately, and (unless the device
 * class never publishes state) arms a revert-on-timeout.
 * @param {string} stateTopic
 * @param {object} patch - e.g. { power: 'ON' } or { brightness: 50 }
 * @param {{deviceClass?: string}} [opts] - `deviceClass` is the entry's
 *   `type` field; used to detect the "never confirms" device classes.
 */
export function applyOptimistic(stateTopic, patch, { deviceClass } = {}) {
  const skipConfirmation = neverConfirms(deviceClass);

  store.updateDevice(stateTopic, (existing) => {
    if (skipConfirmation) {
      return {
        ...existing,
        live: { ...existing.live, ...patch },
        pending: undefined,
        unconfirmed: false,
      };
    }

    return {
      ...existing,
      live: { ...existing.live, ...patch },
      pending: {
        patch,
        previousLive: existing.live,
        deadline: Date.now() + DEFAULT_DEADLINE_MS,
      },
      unconfirmed: false,
    };
  });

  if (skipConfirmation) {
    return;
  }

  const entry = store.deviceByStateTopic(stateTopic);
  const deadline = entry && entry.pending && entry.pending.deadline;
  if (deadline == null) {
    return;
  }
  scheduleRevert(stateTopic, deadline);
}
