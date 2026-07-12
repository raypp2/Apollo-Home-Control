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
 *                (send_somfy_command); the MQTT events are the normalizer +
 *                state layer, per documentation/mqtt-implementation-detail.md
 *                Stage 2.
 *
 *                A shade takes real time to travel (~37s end to end), so the
 *                canonical state NEVER claims a shade has already reached its
 *                commanded position -- only the bridge's native `position`
 *                events (streaming ~every 0.4s during motion) are allowed to
 *                move `position`/`positions`. What send_somfy_command DOES
 *                publish immediately is the MOTION it just requested: `moving`
 *                ('down'|'up'|null) and the commanded `target` (0-100), so the
 *                UI can show "Closing · 34%" using the live-streamed position
 *                while travel is in progress, instead of jumping straight to
 *                the final state and then crawling back as real events catch
 *                up. The native `direction` topic (1 = closing, -1 = opening,
 *                0 = stopped) confirms/corrects `moving` within about a
 *                second and is the sole trigger for clearing it back to null
 *                when motion ends -- see _handleDirection(). Because Somfy RTS
 *                is one-way and ESPSomfy dead-reckons each channel
 *                independently, a GROUP command's member shades never report
 *                their own position/direction; when the group's direction
 *                goes to 0, _handleDirection() snapshots the group's final
 *                position onto every member's cached `positions` entry.
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

/**
 * Copies whichever of `positions`/`moving`/`target`/`movingShades` are
 * present in `cached` onto `state`, so every publish is self-contained
 * regardless of mqttTopics.publishState()'s own (separate) merge-with-
 * previous behavior -- same rationale as `positions` always being fully
 * reattached (see the positionsCache module doc comment above).
 * `moving`/`target` use an explicit hasOwnProperty check rather than
 * truthiness, because their meaningful "at rest" value is `null`, not
 * absence -- a falsy-check would skip republishing a legitimate `null`.
 * @param {object} cached - this entry's positionsCache slot
 * @param {object} state - the publish payload being built; mutated in place
 */
function attachCachedExtras(cached, state) {
    if (cached.positions) {
        state.positions = cached.positions;
    }
    if (Object.prototype.hasOwnProperty.call(cached, 'moving')) {
        state.moving = cached.moving;
    }
    if (Object.prototype.hasOwnProperty.call(cached, 'target')) {
        state.target = cached.target;
    }
    if (cached.movingShades) {
        state.movingShades = cached.movingShades;
    }
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

  const entry = findDeviceByAddress(address);
  if (!entry) {
      return;
  }

  publishCommandMotionState(entry, id, command);
}

/**
 * Publishes the MOTION this command just requested -- never the final
 * position (see the module doc comment for the rationale). Extracted from
 * send_somfy_command so it's independently unit-testable without an HTTP
 * call or booting index.js (see test/somfyBridge.test.js).
 *
 * Sets/caches:
 *  - `moving`: 'down' (closing) | 'up' (opening) | null (stopped), or left
 *    untouched (cached value unchanged) when a numeric target's direction
 *    can't be inferred yet -- no cached current position to compare
 *    against. The native `direction` event (_handleDirection below)
 *    confirms/corrects this within about a second either way.
 *  - `target`: the commanded 0-100 position, or null for STOP.
 *  - `movingShades`: which individually-named shade(s) this command's id
 *    affects -- every member for a group command, the one named shade for
 *    an individual command.
 *
 * Deliberately never touches `position`/`positions` -- those fields only
 * ever move from the bridge's own native position/direction events (see
 * _handlePosition/_handleDirection below), so the displayed position is
 * always the real, physically-confirmed one, not a guess made before the
 * shade has even started moving.
 * @param {object} entry - a devices.json "Somfy-Bridge" entry
 * @param {string|number} id - the ESPSomfy shade id this command targeted
 * @param {string} command - "ON"|"OFF"|"STOP"|<0-100 target>|falsy (=ON)
 */
function publishCommandMotionState(entry, id, command) {
    const mapping = shadeIdMapping(entry);
    const cacheKey = mqttTopics.topicFor(entry, 'state');
    const cached = positionsCache.get(cacheKey) || {};

    // Which shade(s) does this command's id affect -- mirrors the position/
    // direction handlers' own id resolution (see shadeIdMapping()).
    let movingShades;
    if (String(id) === mapping.groupId) {
        movingShades = Array.from(mapping.idToName.values());
    } else if (mapping.idToName.has(String(id))) {
        movingShades = [mapping.idToName.get(String(id))];
    } else {
        // Unrecognized shade id -- nothing we can confidently publish.
        return;
    }

    // `moving` staying `undefined` means "leave the cached value alone" --
    // only the numeric-target branch below can legitimately not know a
    // direction yet.
    let moving;
    let target;
    if (command === 'STOP') {
        moving = null;
        target = null;
    } else if (command === 'ON' || !command) {
        // A falsy command means the dispatch above assumed ON/down (see the
        // "When no command is passed" branch in send_somfy_command) -- mirror
        // that here, otherwise this would say opening while the shade closes.
        moving = 'down';
        target = 100;
    } else if (command === 'OFF') {
        moving = 'up';
        target = 0;
    } else if (!isNaN(command)) {
        target = Number(command);
        const currentPosition = String(id) === mapping.groupId
            ? cached.position
            : (cached.positions && cached.positions[mapping.idToName.get(String(id))]);
        if (typeof currentPosition === 'number') {
            if (target > currentPosition) {
                moving = 'down';
            } else if (target < currentPosition) {
                moving = 'up';
            } else {
                moving = null;
            }
        }
        // else: currentPosition unknown -- `moving` stays undefined (cached
        // value untouched) until the direction event arrives.
    } else {
        // Unrecognized command -- send_somfy_command's own dispatch switch
        // already returns before sending the HTTP request in this case, so
        // this is unreachable in practice; kept defensive.
        return;
    }

    if (moving !== undefined) {
        cached.moving = moving;
    }
    cached.target = target;
    cached.movingShades = movingShades;
    positionsCache.set(cacheKey, cached);

    const state = {};
    attachCachedExtras(cached, state);
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
    attachCachedExtras(cached, state);

    mqttTopics.publishState(entry, state, 'event');
}

/**
 * Handler for `apollo/+/somfy/shades/+/direction`. Payload is 1 (moving
 * down/closing), -1 (moving up/opening), or 0 (stopped). Mirrors
 * _handlePosition's id resolution/logging (shadeIdMapping(), the ignored/
 * unknown-device logging sets), but drives `moving`/`target`/`movingShades`
 * instead of `position`.
 *
 * On direction != 0, publishes `moving` for whichever shade(s) this event's
 * id represents (every member for the group id, one name for an individual
 * id) -- this is the authoritative source for `moving`, confirming/
 * correcting send_somfy_command's own command-time guess (see
 * publishCommandMotionState) within about a second, and also picking up
 * motion triggered by something other than an Apollo-issued command (e.g.
 * the physical remote, or the ESPSomfy app itself).
 *
 * On direction == 0 (motion ended), clears `moving`/`target`/`movingShades`.
 * If the shade that stopped is the GROUP id, this is also the only
 * opportunity to correct the individually-named shades' cached `positions`:
 * a group RTS broadcast physically moves every member shade, but ESPSomfy's
 * one-way dead-reckoning never emits member position events for a group
 * command (see shadeIdMapping()'s doc comment) -- so each member's cached
 * position is snapshotted to the group's own (now-confirmed-real) final
 * position here. This replaces the old command-time optimistic member sync,
 * which guessed the final position before the shade had even started moving.
 * @param {string} topic
 * @param {*} payload
 */
function _handleDirection(topic, payload) {
    const parts = topic.split('/');
    const shadeId = parts.length >= 5 ? parts[4] : undefined;

    if (!shadeId) {
        return;
    }

    const direction = Number(payload);
    if (typeof payload === 'object' || payload === '' || payload === null || Number.isNaN(direction)
        || (direction !== 1 && direction !== 0 && direction !== -1)) {
        console.log('Somfy MQTT: malformed direction payload on %s: %s', topic, JSON.stringify(payload));
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

    let movingShades;
    if (shadeId === mapping.groupId) {
        movingShades = Array.from(mapping.idToName.values());
    } else if (mapping.idToName.has(shadeId)) {
        movingShades = [mapping.idToName.get(shadeId)];
    } else {
        if (!loggedIgnoredShadeIds.has(shadeId)) {
            loggedIgnoredShadeIds.add(shadeId);
            console.log('Somfy MQTT: ignoring direction for untracked shade id "%s" (topic %s)', shadeId, topic);
        }
        return;
    }

    if (direction === 0) {
        cached.moving = null;
        cached.target = null;
        cached.movingShades = [];

        if (shadeId === mapping.groupId && mapping.idToName.size > 0 && typeof cached.position === 'number') {
            cached.positions = { ...(cached.positions || {}) };
            for (const name of mapping.idToName.values()) {
                cached.positions[name] = cached.position;
            }
        }
    } else {
        cached.moving = direction === 1 ? 'down' : 'up';
        cached.movingShades = movingShades;
    }

    positionsCache.set(cacheKey, cached);

    const state = {};
    attachCachedExtras(cached, state);
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
 * Subscribes to the ESPSomfy-RTS bridge's native per-shade position and
 * direction topics, and bridge-level LWT status, across all locations. Safe
 * to call once at startup (mirrors the other listener modules); the
 * subscription registry in mqttClient survives reconnects on its own.
 */
function startSomfyListener() {
    mqttClient.subscribe('apollo/+/somfy/shades/+/position', _handlePosition);
    mqttClient.subscribe('apollo/+/somfy/shades/+/direction', _handleDirection);
    mqttClient.subscribe('apollo/+/somfy/status', _handleBridgeStatus);
}

module.exports = {
    send_somfy_command,
    startSomfyListener,
    _handlePosition,
    _handleDirection,
    _handleBridgeStatus,
    _publishCommandMotionState: publishCommandMotionState,
};