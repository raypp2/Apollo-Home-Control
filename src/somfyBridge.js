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

// The single shade id whose position we track as the canonical state for the
// "shades" config entry -- see module doc / mqtt-implementation-detail.md.
// Shade ids 1-3 are the individual windows paired to this group; only 4
// ("All Windows") is tracked for now.
const TRACKED_SHADE_ID = '4';

// Shade ids whose position/direction events we've already logged as ignored --
// logged once per id (not per message), same pattern as lightingShelly's
// loggedUnknownDevices.
const loggedIgnoredShadeIds = new Set();

// Topic prefixes (device topics, not config entries) whose native status
// didn't resolve to a config entry -- logged once per prefix.
const loggedUnknownDevices = new Set();

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
  //
  // NOTE: this optimistic publish is applied regardless of which shade id
  // (1-3 or 4/"all") the command actually targeted, because canonical state
  // for the "shades" config entry only ever tracks the group (shade 4). The
  // common paths (Alexa / the config's "all" command) target shade 4 anyway,
  // so this is acceptable for now -- see
  // documentation/mqtt-implementation-detail.md Stage 2, ESPSomfy subsection.
  let expectedPosition;
  if (command === "ON") {
      expectedPosition = 100;
  } else if (command === "OFF") {
      expectedPosition = 0;
  } else if (!isNaN(command) && command !== undefined && command !== null && command !== "") {
      expectedPosition = Number(command);
  } else {
      // STOP or unrecognized -- resulting position is unknown, skip publish.
      return;
  }

  const entry = findDeviceByAddress(address);
  if (entry) {
      mqttTopics.publishState(entry, { position: expectedPosition }, 'command');
  }
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
 * semantics). Only shade id 4 ("All Windows") is tracked as canonical state
 * for the single "shades" config entry; ids 1-3 are individual shades and are
 * ignored (logged at most once each). Malformed payloads (non-numeric,
 * out of range) are logged and ignored -- never throws.
 * @param {string} topic
 * @param {*} payload
 */
function _handlePosition(topic, payload) {
    const parts = topic.split('/');
    const shadeId = parts.length >= 5 ? parts[4] : undefined;

    if (shadeId !== TRACKED_SHADE_ID) {
        if (shadeId && !loggedIgnoredShadeIds.has(shadeId)) {
            loggedIgnoredShadeIds.add(shadeId);
            console.log('Somfy MQTT: ignoring position for untracked shade id "%s" (topic %s)', shadeId, topic);
        }
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

    mqttTopics.publishState(entry, { position }, 'event');
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