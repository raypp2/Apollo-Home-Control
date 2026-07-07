/**
 * Apollo Home Control Bridge - Shelly Module
 * @module lightingShelly.js
 *
 * @author Ray Perfetti
 * @date 2023-11-14
 *
 * @description  Controls shelly devices
*                with the ability to turn on/off.
*
*                Also listens for the devices' native Gen2+ MQTT status
*                messages (they are configured, outside of Apollo, to publish
*                to the shared broker under `apollo/<location>/shelly/<mqttName>`)
*                and republishes canonical state via mqttTopics -- see
*                startShellyListener(). Commands stay on HTTP (shelly_command);
*                the MQTT event is only a normalizer + optimistic-state layer,
*                per documentation/mqtt-implementation-detail.md Stage 2.
*/

const http = require('http');
const mqttClient = require('./mqttClient');
const mqttTopics = require('./mqttTopics');

const DRY_RUN = process.env.APOLLO_DRY_RUN === '1';

// Devices whose topic prefix didn't resolve to a config entry -- logged once
// per device name (not per message) to avoid flooding apollo.log for a
// mis-provisioned or decommissioned Shelly.
const loggedUnknownDevices = new Set();

function shelly_command(operation_num, address, command) {

    if (DRY_RUN) {
        console.log("%d - DRY RUN, would send Shelly command: %s to %s", operation_num, command, address);
        return;
    }

    let urlCommand;

    switch (command) {
        case "ON":
            urlCommand = "on";
            break;

        case "OFF":
            urlCommand = "off";
            break;

        default:
            console.log("%d - ERR: Command Not Recognized: %s", operation_num, command);
            return; // Exit the function if the command is not recognized
    }

    const url = `http://${address}/relay/0?turn=${urlCommand}`;

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

    // Optimistic state: the native MQTT status/switch:0 event confirms (or
    // corrects) this within seconds, per Stage 2 of the MQTT plan.
    const entry = findLightByAddress(address);
    if (entry) {
        mqttTopics.publishState(entry, { power: command }, 'command');
    }
}

/**
 * Looks up a lights.json entry by its `address` field (the Shelly's
 * host/IP used for the HTTP relay call).
 * @param {string} address
 * @returns {object|null}
 */
function findLightByAddress(address) {
    const index = require('../index');
    const lights = index.lights || [];
    for (const light of lights) {
        if (light.address === address) {
            return light;
        }
    }
    return null;
}

/**
 * Resolves the config entry for an inbound native-MQTT topic by
 * reconstructing the device's canonical `.../state` topic and delegating to
 * mqttTopics.findByTopic() -- the single canonical reverse-lookup, per the
 * module's own doc comment. Never duplicates its matching logic.
 *
 * The native topics are `apollo/<location>/shelly/<mqttName>/status/switch:0`
 * and `.../online`; the first four segments are the prefix.
 * @param {string} topic
 * @returns {object|null}
 */
function resolveEntry(topic) {
    const parts = topic.split('/');
    if (parts.length < 4) {
        return null;
    }
    const prefix = parts.slice(0, 4).join('/');
    return mqttTopics.findByTopic(`${prefix}/state`);
}

/**
 * Logs an unresolved device topic exactly once per device name (the 4th
 * topic segment, i.e. mqttName), not once per message.
 * @param {string} topic
 */
function logUnknownDevice(topic) {
    const parts = topic.split('/');
    const deviceName = parts.length >= 4 ? parts[3] : topic;
    if (!loggedUnknownDevices.has(deviceName)) {
        loggedUnknownDevices.add(deviceName);
        console.log('Shelly MQTT: no config entry found for device "%s" (topic %s)', deviceName, topic);
    }
}

/**
 * Handler for `apollo/+/shelly/+/status/switch:0`. Normalizes the native
 * Gen2+ payload (`{"output": true, ...}`) into canonical state and updates
 * the in-memory lights entry the same way lighting.js does so /list/lights
 * stays accurate for the dashboard. Never throws -- malformed payloads
 * (missing `output`, non-object payloads, etc.) are logged and ignored.
 * @param {string} topic
 * @param {*} payload
 */
function _handleSwitchStatus(topic, payload) {
    if (!payload || typeof payload !== 'object' || typeof payload.output !== 'boolean') {
        console.log('Shelly MQTT: malformed status/switch:0 payload on %s: %s', topic, JSON.stringify(payload));
        return;
    }

    const entry = resolveEntry(topic);
    if (!entry) {
        logUnknownDevice(topic);
        return;
    }

    mqttTopics.publishState(entry, { power: payload.output ? 'ON' : 'OFF' }, 'event');

    entry.checked = payload.output;
    entry.status = payload.output ? 100 : 0;
}

/**
 * Handler for `apollo/+/shelly/+/online` (the device's LWT). `false` marks
 * the device unreachable; `true` is a no-op -- a status/switch:0 message
 * follows on its own once the device is back.
 * @param {string} topic
 * @param {*} payload
 */
function _handleOnline(topic, payload) {
    if (payload !== true && payload !== false) {
        console.log('Shelly MQTT: malformed online payload on %s: %s', topic, JSON.stringify(payload));
        return;
    }

    if (payload === true) {
        return;
    }

    const entry = resolveEntry(topic);
    if (!entry) {
        logUnknownDevice(topic);
        return;
    }

    mqttTopics.publishUnreachable(entry);
}

/**
 * Subscribes to native Shelly Gen2+ status/LWT topics across all locations.
 * Safe to call once at startup (mirrors the other listener modules); the
 * subscription registry in mqttClient survives reconnects on its own.
 */
function startShellyListener() {
    mqttClient.subscribe('apollo/+/shelly/+/status/switch:0', _handleSwitchStatus);
    mqttClient.subscribe('apollo/+/shelly/+/online', _handleOnline);
}

module.exports = {
    shelly_command,
    startShellyListener,
    _handleSwitchStatus,
    _handleOnline,
  };
