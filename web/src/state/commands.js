// Apollo v2 dashboard -- device command dispatch + normalized view model.
//
// One place that knows how a config entry maps to (a) a normalized shape the
// UI can render uniformly -- `deviceView(entry)` -- and (b) the /api command
// paths that actuate it. Both the isometric plane (fixture dots) and the
// command panel (device rows) consume `deviceView`; only the panel dispatches.
//
// Command paths follow the handler grammar: /api/<MODULE>/<ID>/<CMD>/<P1?>.
// Segments are uppercased server-side, so pass them as-is. Commands are
// fire-and-forget; the optimistic layer shows intent, MQTT confirms.
//
// Scope note (increment 2): only LIGHTS (dim/switch) and the Somfy shade are
// dispatchable here. Color pickers (increment 3), AV/climate/projector/utility
// (increment 4) extend `kindOf`/`deviceView` and add their own command paths.

import * as store from './store.js';
import { sendCommand } from './api.js';
import { applyOptimistic } from './optimistic.js';
import { setLastAction } from './ui.js';

// Config `type` values that dim smoothly enough to stream level changes during
// a drag. Everything else commits once, on pointer release.
const LIVE_DRAG_TYPES = new Set(['hue-group', 'dmxFixture']);

/**
 * @param {object} entry - a store device entry
 * @returns {'dim'|'switch'|'shade'|'other'}
 */
export function kindOf(entry) {
  if (!entry) return 'other';
  if (entry.type === 'Somfy-Bridge') return 'shade';
  if (entry.module === 'LIGHTS') {
    // Color-capable Hue lights (config `isColor`) render as a dim row plus a
    // swatch picker. Otherwise: Insteon/Hue/DMX dim, Shelly/WLED on/off relays.
    // `alexa.isDimmable` is the authoritative dimmable flag carried in config.
    if (entry.isColor) return 'color';
    return entry.alexa && entry.alexa.isDimmable ? 'dim' : 'switch';
  }
  return 'other';
}

/** Whether a light entry is currently on (power === 'ON'). */
export function isOn(entry) {
  return Boolean(entry && entry.live && entry.live.power === 'ON');
}

/** Current 0-100 level for a dim light (brightness, or 100/0 by power). */
export function levelOf(entry) {
  const b = entry && entry.live && entry.live.brightness;
  if (typeof b === 'number') return b;
  return isOn(entry) ? 100 : 0;
}

/** Current 0-100 shade position (0 = open/up, 100 = closed/down). */
export function positionOf(entry) {
  const p = entry && entry.live && entry.live.position;
  return typeof p === 'number' ? p : 0;
}

/**
 * Drag-commit policy for this device: 'live' streams level changes to the
 * backend during the drag; 'release' updates only the local display during the
 * drag and sends a single command on release (Insteon can't absorb a stream).
 * @param {object} entry
 * @returns {'live'|'release'}
 */
export function commitMode(entry) {
  return entry && LIVE_DRAG_TYPES.has(entry.type) ? 'live' : 'release';
}

/**
 * A normalized view of a device for uniform rendering by plane + panel.
 * @param {object} entry
 * @returns {{kind:string, on:boolean, level:number, position:number,
 *            color:?string, reachable:boolean, stale:boolean,
 *            unconfirmed:boolean, commit:string, title:string}}
 */
export function deviceView(entry) {
  const kind = kindOf(entry);
  const live = (entry && entry.live) || {};
  return {
    kind,
    on: kind === 'shade' ? positionOf(entry) > 0 : isOn(entry),
    level: levelOf(entry),
    position: positionOf(entry),
    color: live.color || null,
    reachable: live.reachable !== false,
    stale: Boolean(entry && entry.stale),
    unconfirmed: Boolean(entry && entry.unconfirmed),
    commit: commitMode(entry),
    title: (entry && entry.title) || (entry && entry.id) || '',
  };
}

// --- dispatch -------------------------------------------------------------

function fire(entry, segments, patch, trace) {
  applyOptimistic(entry.stateTopic, patch, { deviceClass: entry.type });
  setLastAction(trace);
  // Fire-and-forget; failures surface via the optimistic revert timeout.
  sendCommand([entry.module, entry.id, ...segments]).catch(() => {});
}

/** Toggle a light on/off. */
export function toggle(entry) {
  const next = !isOn(entry);
  fire(entry, [next ? 'on' : 'off'], { power: next ? 'ON' : 'OFF' },
    `${entry.title} ${next ? 'on' : 'off'}`);
}

/**
 * Update a dim light's local display WITHOUT sending -- used during a
 * 'release'-mode drag so the row fill and plan dot track the finger while the
 * command is withheld until release. No optimistic pending/revert is armed.
 * @param {object} entry
 * @param {number} val 0-100
 */
export function previewLevel(entry, val) {
  const v = clamp(val);
  store.updateDevice(entry.stateTopic, (e) => ({
    ...e,
    live: { ...e.live, brightness: v, power: v > 0 ? 'ON' : 'OFF' },
  }));
}

/** Commit a dim light level: optimistic + send + trace. */
export function commitLevel(entry, val) {
  const v = clamp(val);
  fire(entry, [String(v)], { power: v > 0 ? 'ON' : 'OFF', brightness: v },
    `${entry.title} → ${v}%`);
}

// The design's fixed swatch palette for color-capable lights.
export const COLOR_CHOICES = ['#f2a65e', '#e86a6a', '#a688e8', '#6ab5e8', '#7ed9a0', '#e8d36a'];

/**
 * Set a color-capable light's color: optimistic + send + trace. Command path
 * is /api/LIGHTS/<id>/COLOR/<hex-without-#>; setting a color implies power on.
 * @param {object} entry
 * @param {string} hex - '#rrggbb' or 'rrggbb'
 */
export function setColor(entry, hex) {
  const clean = hex.replace('#', '').toLowerCase();
  fire(entry, ['COLOR', clean], { power: 'ON', color: '#' + clean },
    `${entry.title} → #${clean}`);
}

/** Update a shade's local display without sending (drag preview). */
export function previewPosition(entry, val) {
  const v = clamp(val);
  store.updateDevice(entry.stateTopic, (e) => ({ ...e, live: { ...e.live, position: v } }));
}

/** Commit a shade position: optimistic + send + trace. */
export function commitPosition(entry, val) {
  const v = clamp(val);
  fire(entry, [String(v)], { position: v }, `${entry.title} → ${v}%`);
}

/** Tap a shade: toggle fully open (0) / closed (100) by its current half. */
export function toggleShade(entry) {
  const next = positionOf(entry) < 50 ? 100 : 0;
  fire(entry, [String(next)], { position: next },
    `${entry.title} ${next === 0 ? 'open' : 'closed'}`);
}

function clamp(v) {
  return Math.max(0, Math.min(100, Math.round(v)));
}

// --- scenes & macros ------------------------------------------------------
// Scene/macro entries live in store.scenes / store.macros keyed by id, each
// carrying an `active` flag (scenes reconciled by fingerprint drift, macros a
// last-activation boolean). Dispatch is /api/LIGHTINGSCENES/<id>/<on|off> and
// /api/MACROS/<id>/<on|off>; we optimistically flip `active` locally and let
// the retained apollo/home/{scene,macro}/<id>/state message reconcile.

/** Toggle a lighting scene on/off. */
export function toggleScene(entry) {
  const next = !entry.active;
  store.updateScene(store.scenes, entry.id, (e) => ({ ...e, active: next }));
  setLastAction(`${entry.title} ${next ? 'on' : 'off'}`);
  sendCommand(['LIGHTINGSCENES', entry.id, next ? 'on' : 'off']).catch(() => {});
}

/** Explicitly set a scene on or off (for split On/Off chips like All Lights). */
export function setScene(entry, on) {
  store.updateScene(store.scenes, entry.id, (e) => ({ ...e, active: on }));
  setLastAction(`${entry.title} ${on ? 'on' : 'off'}`);
  sendCommand(['LIGHTINGSCENES', entry.id, on ? 'on' : 'off']).catch(() => {});
}

/** Toggle a macro on/off. */
export function toggleMacro(entry) {
  const next = !entry.active;
  store.updateScene(store.macros, entry.id, (e) => ({ ...e, active: next }));
  setLastAction(`${entry.title} ${next ? 'on' : 'off'}`);
  sendCommand(['MACROS', entry.id, next ? 'on' : 'off']).catch(() => {});
}

// --- momentary triggers (door, find-my, projector) -----------------------
// Fire-and-forget; no optimistic state (there's nothing persistent to toggle).
export function momentary(entry, segments, trace) {
  setLastAction(trace);
  sendCommand([entry.module || 'DEVICES', entry.id, ...segments]).catch(() => {});
}

function patchLive(entry, patch) {
  store.updateDevice(entry.stateTopic, (e) => ({ ...e, live: { ...e.live, ...patch } }));
}

// --- climate (AC shadow) --------------------------------------------------
// AC entry.live carries {power, mode:'COOL'|'ECO', setpoint:int, fan}. All
// dispatch through the AC module → src/climateShadow.js.
export function climatePower(entry, on) {
  patchLive(entry, { power: on ? 'ON' : 'OFF' });
  setLastAction(`AC ${on ? 'on' : 'off'}`);
  sendCommand(['AC', entry.id, on ? 'on' : 'off']).catch(() => {});
}
export function climateSetpoint(entry, n) {
  const v = Math.max(60, Math.min(80, Math.round(n)));
  patchLive(entry, { setpoint: v });
  setLastAction(`AC → ${v}°`);
  sendCommand(['AC', entry.id, 'setpoint', String(v)]).catch(() => {});
}
export function climateMode(entry, mode) {
  patchLive(entry, { mode });
  setLastAction(`AC ${mode}`);
  sendCommand(['AC', entry.id, 'mode', mode]).catch(() => {});
}
export function climateFan(entry, fan) {
  patchLive(entry, { fan });
  setLastAction(`AC fan ${fan}`);
  sendCommand(['AC', entry.id, 'fan', fan]).catch(() => {});
}
/** Correct the shadow WITHOUT sending IR (drift recalibration). */
export function climateOverride(entry, patch) {
  patchLive(entry, patch);
  setLastAction('AC override');
  for (const [k, v] of Object.entries(patch)) {
    sendCommand(['AC', entry.id, 'override_' + k, String(v)]).catch(() => {});
  }
}

// --- AV receiver (Anthem) -------------------------------------------------
// entry.live: {power, volume (negative dB int), input (number), mute}.
export function avPower(entry, on) {
  patchLive(entry, { power: on ? 'ON' : 'OFF' });
  setLastAction(`Receiver ${on ? 'on' : 'off'}`);
  sendCommand(['DEVICES', entry.id, on ? 'on' : 'off']).catch(() => {});
}
/** Set volume in dB (negative). Command sends the magnitude (Z1VOL-<n>). */
export function avVolume(entry, db) {
  const v = Math.round(db);
  patchLive(entry, { volume: v });
  setLastAction(`Receiver ${v} dB`);
  sendCommand(['SPEAKERS', entry.id, 'setvolume', String(Math.abs(v))]).catch(() => {});
}
export function avMute(entry) {
  const next = !(entry.live && entry.live.mute);
  patchLive(entry, { mute: next });
  setLastAction(`Receiver ${next ? 'muted' : 'unmuted'}`);
  sendCommand(['DEVICES', entry.id, 'muteToggle']).catch(() => {});
}
/** Raw receiver input (drill-in / debug surface): Z1INP<n>. */
export function avInputRaw(entry, inputCmd, label) {
  patchLive(entry, { power: 'ON' });
  setLastAction(`Receiver → ${label || inputCmd}`);
  sendCommand(['DEVICES', entry.id, inputCmd]).catch(() => {});
}
/** Panel INPUT: fires the full device scene (input + video + keypad blink). */
export function avInputScene(deviceSceneId, label) {
  setLastAction(`Source → ${label || deviceSceneId}`);
  sendCommand(['DEVICESCENES', deviceSceneId, 'on']).catch(() => {});
}

// --- Spotify now-playing transport ---------------------------------------
export function spotifyPlayPause(entry, isPlaying) {
  setLastAction(isPlaying ? 'Spotify pause' : 'Spotify play');
  sendCommand(['DEVICES', entry.id, isPlaying ? 'pause' : 'play']).catch(() => {});
}

// --- room on/off toggle + group dim --------------------------------------
// The room button (Living Room, Office, ...) is a scene-toggle plus a group
// dimmer: state = any controllable light in the room is on; tap toggles (on ->
// all off, off -> fire the room's lighting scene); hold+drag dims every
// dimmable light in the room together. Rooms with a dedicated lighting scene
// use it for the "on" look; others just switch their lights on.
const ROOM_SCENE = { living: 'livingRoom', office: 'office' };

/** Controllable lights in a room (dim/switch/color; excludes shade/other). */
export function roomLights(roomId) {
  return store.devicesInRoom(roomId).filter((e) => {
    const k = kindOf(e);
    return k === 'dim' || k === 'switch' || k === 'color';
  });
}

/** True if any controllable light in the room is on. */
export function roomAnyOn(roomId) {
  return roomLights(roomId).some((e) => isOn(e));
}

/** Representative room level (max brightness of on dimmable lights, else 0). */
export function roomLevel(roomId) {
  let max = 0;
  for (const e of roomLights(roomId)) {
    if (isOn(e) && (kindOf(e) === 'dim' || kindOf(e) === 'color')) {
      max = Math.max(max, levelOf(e));
    }
  }
  return max;
}

/** Tap the room button: on -> everything off; off -> the room's scene/all-on. */
export function roomToggle(roomId) {
  if (roomAnyOn(roomId)) {
    for (const e of roomLights(roomId)) {
      if (isOn(e)) toggle(e);
    }
    setLastAction(`${roomId} off`);
  } else {
    const sceneId = ROOM_SCENE[roomId];
    if (sceneId && store.scenes.value.get(sceneId)) {
      const scene = store.scenes.value.get(sceneId);
      store.updateScene(store.scenes, sceneId, (s) => ({ ...s, active: true }));
      sendCommand(['LIGHTINGSCENES', sceneId, 'on']).catch(() => {});
      setLastAction(`${scene.title} on`);
    } else {
      for (const e of roomLights(roomId)) {
        if (!isOn(e)) toggle(e);
      }
      setLastAction(`${roomId} on`);
    }
  }
}

/** Hold+drag the room button: set every dimmable light in the room to `val`. */
export function roomDim(roomId, val, { commit = false } = {}) {
  const v = clamp(val);
  for (const e of roomLights(roomId)) {
    if (kindOf(e) === 'dim' || kindOf(e) === 'color') {
      if (commit) commitLevel(e, v);
      else previewLevel(e, v);
    } else if (commit) {
      // switch: on above zero, off at zero
      const wantOn = v > 0;
      if (isOn(e) !== wantOn) toggle(e);
    }
  }
  if (commit) setLastAction(`${roomId} → ${v}%`);
}

// --- utility rail (door buzzer, find-my ping) ----------------------------
/** Buzz the door open (/api/LOCKS/door/<which>/unlock). `which` = front|apartment. */
export function buzzDoor(entry, which = 'front') {
  setLastAction(`Door ${which}`);
  sendCommand(['LOCKS', entry.id, which, 'unlock']).catch(() => {});
}
/** Ping the phone via Find My iPhone. */
export function pingPhone(entry) {
  setLastAction('Ping iPhone');
  sendCommand(['DEVICES', entry.id, 'on']).catch(() => {});
}
