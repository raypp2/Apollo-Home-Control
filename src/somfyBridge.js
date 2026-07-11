/**
 * Apollo Home Control Bridge - Somfy Module
 * @module somfyBridge.js
 *
 * @author Ray Perfetti
 * @date 2023-10-05
 *
 * @description   Controls Somfy shades via a separate bridge application ESPSomfy-RTS
 *                https://github.com/rstrouse/ESPSomfy-RTS
 *
 *                The hardware is an ESP32 with a CC1101 Transceiver costsing about $12.
 *
 *                If you've messed around with Somfy, you know that the RTS controllers are absurdly expensive.
 *                The Universal RTS Interface II (URTSI II-16 Channel) is $400+
 *
 *                This module just sends the command. Transmission to the shades is handled by the bridge.
 *
 *                Also listens for the bridge's native MQTT status messages (the
 *                ESPSomfy-RTS bridge is configured, outside of Apollo, to publish
 *                to the shared broker under its root topic
 *                `apollo/<location>/somfy`) and republishes canonical state via
 *                mqttTopics -- see startSomfyListener(). Commands stay on HTTP
 *                (send_somfy_command); the MQTT event is only a normalizer +
 *                optimistic-state layer, per
 *                documentation/mqtt-implementation-detail.md Stage 2.
 *
 */

const http = require('http');
const mqttClient = require('./mqttClient');
const mqttTopics = require('./mqttTopics');

const DRY_RUN = process.env.APOLLO_DRY_RUN === '1';

// Command-map alias keys that all point at the group shade id (not an
// individual shade) -- see shadeIdMapping() below. Excluded when deriving
// the id->friendly-name map for the `positions` object.
const NON_INDIVIDUAL_ALIASES = new Set(['on', 'off', 'all']);

// Fallback group shade id used only when a config entry has no `commands`
// map to derive one from (defensive -- devices.json's real "shades" entry
// always has one; this just keeps a minimal/legacy entry from breaking).
const DEFAULT_GROUP_ID = '4';

// Per-entry cache of last-known shade positions, keyed by the entry's
// canonical `.../state` topic (same key mqttTopics.js's own stateCache
// uses). Holds { position, positions } so every publish -- whether it's the
// group shade or a single named shade that changed -- can carry the FULL
// `positions` object; mqttTopics.publishState()'s merge is shallow, so a
// partial `positions: {one: 40}` would clobber `two`/`three` if we didn't
// keep our own complete copy to republish each time.
const positionsCache = new Map();

// Shade ids whose position/direction events we've already logged as ignored
// (unrecognized by shadeIdMapping()) -- logged once per id (not per
// message), same pattern as lightingShelly's loggedUnknownDevices.
const loggedIgnoredShadeIds = new Set();

// Topic prefixes (device topics, not config entries) whose native status
// didn't resolve to a config entry -- logged once per prefix.
const loggedUnknownDevices = new Set();

/**
 * Derives the shade-id -> role mapping for a devices.json "shades" entry
 * PURELY from its own `commands` map -- never hardcoded here, so a
 * re-wired/rebound ESPSomfy channel just needs its config updated, not this
 * module. `commands` looks like {on:"4", off:"4", all:"4", one:"3", two:"2",
 * three:"1"}: "on"/"off"/"all" are aliases for the group shade id (id 4 in
 * the example), and the remaining keys ("one"/"two"/"three") are individual
 * shade names -> ESPSomfy shade ids. Falls back to DEFAULT_GROUP_ID (and an
 * empty individual-shade map) when the entry has no usable `commands` map.
 * @param {object} entry - a devices.json "Somfy-Bridge" entry
 * @returns {{groupId: string, idToName: Map<string,string>}}
 */
function shadeIdMapping(entry) {
    const commands = (entry && entry.commands) || {};
    const groupId = commands.all !== undefined ? String(commands.all)
        : commands.on !== undefined ? String(commands.on)
            : DEFAULT_GROUP_ID;

    const idToName = new Map();
    for (const [name, id] of Object.entries(commands)) {
        if (NON_INDIVIDUAL_ALIASES.has(name)) {
            continue;
        }
        idToName.set(String(id), name);
    }

    return { groupId, idToName };
}

function send_somfy_command (address, id, command, operation_num) {

  if (DRY_RUN) {
    console.log("%d - DRY RUN, would send Somfy command: %s to shade %s @ %s", operation_num, command, id, address);
    return;
  }

  let urlCommand;

  // See documentation @ https://github.com/rstrouse/ESPSomfy-RTS/wiki/Integrations
  switch (command) {
      case "ON":
          urlCommand = "command=down";
          break;

      case "OFF":
          urlCommand = "command=up";
          break;

      case "STOP":
          urlCommand = "command=my";
          break;

      default:
          if(!command){
            // When no command is passed, we assume ON
            urlCommand = "command=down";
          } else if(!isNaN(command)){
              // If the command is a number, it's a percentage [0-100] that the shade should move to
              urlCommand = "target=" + command;
          } else {
              console.log("%d - ERR: Command Not Recognized: %s", operation_num, command);
              return; // Exit the function if the command is not recognized
          }
  }

  const url = `http://${address}/shadeCommand?shadeId=${id}&${urlCommand}`;
  console.log("%d - URL: %s", operation_num, url);

  http.get(url, (resp) => {
      let data = '';

      resp.on('data', (chunk) => {
          data += chunk;
      });

      resp.on('end', () => {
          console.log("%d - Response: %s", operation_num, data);
      });

  }).on("error", (err) => {
      console.log("%d - Error: %s", operation_num, err.message);
  });

  console.log("%d - Sent Command: %s", operation_num, command);

  // Optimistic state: the native MQTT shades/<id>/position event confirms (or
  // corrects) this within seconds, per Stage 2 of the MQTT plan. Map the
  // command to the position it should settle at; "STOP" and anything else
  // unrecognized have no predictable resulting position, so we skip.
  let expectedPosition;
  if (command === "ON" || !command) {
      // A falsy command means the dispatch above assumed ON/down (see the
      // "When no command is passed" branch) -- mirror that here, otherwise
      // the optimistic state would say open while the shade closes.
      expectedPosition = 100;
  } else if (command === "OFF") {
      expectedPosition = 0;
  } else if (!isNaN(command)) {
      expectedPosition = Number(command);
  } else {
      // STOP or unrecognized -- resulting position is unknown, skip publish.
      return;
  }

  const entry = findDeviceByAddress(address);
  if (!entry) {
      return;
  }

  // Which shade id did this command target -- the group, or one of the
  // individually-named shades? Only touch the field that actually changed:
  // the top-level `position` for a group command, or that shade's entry
  // inside `positions` for an individual one -- see shadeIdMapping() and the
  // positionsCache module doc comment above.
  const mapping = shadeIdMapping(entry);
  const cacheKey = mqttTopics.topicFor(entry, 'state');
  const cached = positionsCache.get(cacheKey) || {};

  const state = {};
  if (String(id) === mapping.groupId) {
      cached.position = expectedPosition;
      state.position = expectedPosition;
      // A group-channel RTS broadcast physically moves EVERY member shade,
      // but Somfy RTS is one-way and ESPSomfy dead-reckons each channel
      // independently -- it emits no member position events for a group
      // command, so the members' last-known positions would go stale
      // (live-verified: open-all left a shade's cached position at 20).
      // Optimistically move every named member along with the group.
      if (mapping.idToName.size > 0) {
          cached.positions = { ...(cached.positions || {}) };
          for (const name of mapping.idToName.values()) {
              cached.positions[name] = expectedPosition;
          }
      }
  } else if (mapping.idToName.has(String(id))) {
      cached.positions = { ...(cached.positions || {}), [mapping.idToName.get(String(id))]: expectedPosition };
  } else {
      // Unrecognized shade id -- nothing we can confidently update.
      return;
  }

  positionsCache.set(cacheKey, cached);
  if (cached.positions) {
      // Always attach the full cache, even for a group-only change, so this
      // publish is self-contained regardless of mqttTopics' own merge.
      state.positions = cached.positions;
  }

  mqttTopics.publishState(entry, state, 'command');
}

/**
 * Looks up a devices.json entry by its `address` field (the ESPSomfy bridge's
 * host/IP used for the HTTP shadeCommand call). Mirrors lightingShelly.js's
 * findLightByAddress, but against the `devices` array (shades live in
 * devices.json, not lights.json).
 * @param {string} address
 * @returns {object|null}
 */
function findDeviceByAddress(address) {
    const index = require('../index');
    const devices = index.devices || [];
    for (const device of devices) {
        if (device.address === address) {
            return device;
        }
    }
    return null;
}

/**
 * Resolves the config entry for an inbound native-MQTT shade topic by
 * reconstructing the device's canonical `.../state` topic and delegating to
 * mqttTopics.findByTopic() -- the single canonical reverse-lookup. Never
 * duplicates its matching logic.
 *
 * The native shade topics are `apollo/<location>/somfy/shades/<shadeId>/position`
 * etc; the first FOUR segments (`apollo/<location>/somfy/shades`) are the
 * prefix, matching the config's canonical `.../shades/state` topic exactly.
 * @param {string} topic
 * @returns {object|null}
 */
function resolveShadeEntry(topic) {
    const parts = topic.split('/');
    if (parts.length < 4) {
        return null;
    }
    const prefix = parts.slice(0, 4).join('/');
    return mqttTopics.findByTopic(`${prefix}/state`);
}

/**
 * Resolves the config entry for the bridge-level `.../somfy/status` topic.
 * Here the prefix is the first THREE segments (`apollo/<location>/somfy`);
 * reconstruct `<prefix>/shades/state` to match the config's canonical topic.
 * @param {string} topic
 * @returns {object|null}
 */
function resolveBridgeEntry(topic) {
    const parts = topic.split('/');
    if (parts.length < 3) {
        return null;
    }
    const prefix = parts.slice(0, 3).join('/');
    return mqttTopics.findByTopic(`${prefix}/shades/state`);
}

/**
 * Logs an unresolved device topic exactly once per prefix, not once per
 * message.
 * @param {string} topic
 * @param {string} prefix
 */
function logUnknownDevice(topic, prefix) {
    if (!loggedUnknownDevices.has(prefix)) {
        loggedUnknownDevices.add(prefix);
        console.log('Somfy MQTT: no config entry found for "%s" (topic %s)', prefix, topic);
    }
}

/**
 * Handler for `apollo/+/somfy/shades/+/position`. Payload is a plain number
 * 0-100 (0 = open/up, 100 = closed/down -- matches our canonical `position`
 * semantics). ALL four shade ids are tracked: the group id keeps updating
 * the top-level `position` field (unchanged meaning, for backward compat),
 * and the three individually-named shades update their entry inside the
 * `positions` object (see shadeIdMapping()/positionsCache above) -- every
 * publish carries the complete `positions` object, not just the shade that
 * just changed. An id this entry's `commands` map doesn't recognize is
 * logged at most once and otherwise ignored. Malformed payloads
 * (non-numeric, out of range) are logged and ignored -- never throws.
 * @param {string} topic
 * @param {*} payload
 */
function _handlePosition(topic, payload) {
    const parts = topic.split('/');
    const shadeId = parts.length >= 5 ? parts[4] : undefined;

    if (!shadeId) {
        return;
    }

    const position = Number(payload);
    if (typeof payload === 'object' || payload === '' || payload === null || Number.isNaN(position) || position < 0 || position > 100) {
        console.log('Somfy MQTT: malformed position payload on %s: %s', topic, JSON.stringify(payload));
        return;
    }

    const entry = resolveShadeEntry(topic);
    if (!entry) {
        logUnknownDevice(topic, parts.slice(0, 4).join('/'));
        return;
    }

    const mapping = shadeIdMapping(entry);
    const cacheKey = mqttTopics.topicFor(entry, 'state');
    const cached = positionsCache.get(cacheKey) || {};

    const state = {};
    if (shadeId === mapping.groupId) {
        cached.position = position;
        state.position = position;
    } else if (mapping.idToName.has(shadeId)) {
        cached.positions = { ...(cached.positions || {}), [mapping.idToName.get(shadeId)]: position };
    } else {
        if (!loggedIgnoredShadeIds.has(shadeId)) {
            loggedIgnoredShadeIds.add(shadeId);
            console.log('Somfy MQTT: ignoring position for untracked shade id "%s" (topic %s)', shadeId, topic);
        }
        return;
    }

    positionsCache.set(cacheKey, cached);
    if (cached.positions) {
        state.positions = cached.positions;
    }

    mqttTopics.publishState(entry, state, 'event');
}

/**
 * Handler for `apollo/+/somfy/status` (the bridge's own LWT, not per-shade).
 * `"offline"` marks the tracked "shades" entry unreachable; `"online"` is a
 * no-op -- per-shade position messages follow on their own once the bridge is
 * back.
 * @param {string} topic
 * @param {*} payload
 */
function _handleBridgeStatus(topic, payload) {
    if (payload !== 'online' && payload !== 'offline') {
        console.log('Somfy MQTT: unrecognized status payload on %s: %s', topic, JSON.stringify(payload));
        return;
    }

    if (payload === 'online') {
        return;
    }

    const entry = resolveBridgeEntry(topic);
    if (!entry) {
        logUnknownDevice(topic, topic.split('/').slice(0, 3).join('/'));
        return;
    }

    mqttTopics.publishUnreachable(entry);
}

/**
 * Subscribes to the ESPSomfy-RTS bridge's native per-shade position topics
 * and bridge-level LWT status across all locations. Safe to call once at
 * startup (mirrors the other listener modules); the subscription registry in
 * mqttClient survives reconnects on its own.
 */
function startSomfyListener() {
    mqttClient.subscribe('apollo/+/somfy/shades/+/position', _handlePosition);
    mqttClient.subscribe('apollo/+/somfy/status', _handleBridgeStatus);
}

module.exports = {
    send_somfy_command,
    startSomfyListener,
    _handlePosition,
    _handleBridgeStatus,
};