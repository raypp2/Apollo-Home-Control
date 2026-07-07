/**
 * Apollo Home Control Bridge - Philips Hue Module
 * @module lightingPhilipsHue.js
 * 
 * @author Ray Perfetti
 * @date 2023-10-08
 * 
 * @description   Controls lighting fixtures and scenes on the Insteon and Philips Hue platforms
 *                with the ability to turn on/off, dim, and execute scenes.
 * 
 *                Developer Note
 *                While this is updated for the v3 API, the ActivateScene convenience method is used
 *                but should be replaced by controlling each group individually.
 *
 *                Dependencies:
 *                - Philips Hue Bridge (tested with model 3241312018A)
 *                - node-hue-api by Peter Murray
 *                    https://github.com/peter-murray/node-hue-api
 *
 *                MQTT (Stage 4, issue #12): after a successful group command,
 *                publishes optimistic `command`-source canonical state via
 *                mqttTopics -- no verification poll is scheduled here (unlike
 *                lightingInsteon.js's), because lightingPhilipsHueListener.js's
 *                SSE stream self-corrects within ~1s on its own. Scene commands
 *                (hue_scene_command) deliberately do NOT publish optimistic
 *                state -- a scene's fan-out to member lights/groups isn't known
 *                here, so there's no single group state to guess; SSE reports
 *                whatever groups the scene actually changed.
 *
 */


'use strict';

const hueApi = require('node-hue-api');
const v3 = hueApi.v3;
const GroupLightState = v3.lightStates.GroupLightState;

var hue_controller = {
  host: process.env.PHILIPS_HUE_IP,
  username: process.env.PHILIPS_HUE_USERNAME,
};

// Memoized as a PROMISE, not the resolved api -- two concurrent first calls
// (e.g. two commands arriving before the bridge connection finishes) must
// share the single in-flight connect() rather than each starting their own.
// On failure, apiPromise is reset to null so the next call retries instead of
// being permanently stuck on a rejected promise.
let apiPromise = null;

function initializeApi() {
  if (!apiPromise) {
    apiPromise = v3.api.createLocal(hue_controller.host).connect(hue_controller.username)
      .catch((err) => {
        apiPromise = null;
        throw err;
      });
  }
  return apiPromise;
}

/**
 * Looks up the lights.json entry for a Hue group by its group number
 * (`address`, matched as a string -- lights.json addresses are strings).
 * Lazily requires ../index, same load-order rule as every other src/ module.
 * @param {string|number} groupHue
 * @returns {object|null}
 */
function findLightByGroup(groupHue) {
  const index = require('../index');
  const lights = index.lights || [];
  const target = String(groupHue);
  for (const light of lights) {
    if (light.type === 'hue-group' && light.address === target) {
      return light;
    }
  }
  return null;
}

/**
 * Publishes optimistic (source:"command") state for a group command that
 * just succeeded. ON/OFF publish just the power field; a numeric brightness
 * command implies the group is now on at that level. Any other value (should
 * be unreachable -- hue_group_command already branched on these same three
 * cases to build groupState) is skipped. No-op if the group has no matching
 * lights.json entry.
 * @param {string|number} groupHue
 * @param {string} lighting_command - already uppercased
 */
function publishOptimisticGroupState(groupHue, lighting_command) {
  const entry = findLightByGroup(groupHue);
  if (!entry) {
    return;
  }

  const mqttTopics = require('./mqttTopics');

  if (lighting_command === 'ON') {
    mqttTopics.publishState(entry, { power: 'ON' }, 'command');
  } else if (lighting_command === 'OFF') {
    mqttTopics.publishState(entry, { power: 'OFF' }, 'command');
  } else if (!isNaN(lighting_command)) {
    mqttTopics.publishState(entry, { power: 'ON', brightness: Number(lighting_command) }, 'command');
  }
}

async function hue_group_command(operation_num, groupHue, lighting_command) {
  const api = await initializeApi();
  let groupState;
  lighting_command = lighting_command.toUpperCase(); // Make case insensitive

  try {
    if (lighting_command === 'OFF') {
      // console.log("Attempting to turn OFF group %s", groupHue);
      groupState = new GroupLightState().off();
    } else if (lighting_command === 'ON') {
      // console.log("Attempting to turn ON group %s", groupHue);
      groupState = new GroupLightState().on();
    } else {
      groupState = new GroupLightState().brightness(lighting_command);
    }

    await api.groups.setGroupState(groupHue, groupState);
    console.log(`${operation_num} - Successfully executed lighting command: ${lighting_command}`);

    publishOptimisticGroupState(groupHue, lighting_command);
  } catch (err) {
    console.log(`${operation_num} - ERR: Failed to execute lighting command: ${err}`);
  }
}

async function hue_scene_command(operation_num, sceneID, lighting_command, groupHue) {
    const api = await initializeApi();
    lighting_command = lighting_command.toUpperCase(); // Make case insensitive

    try {
        if(lighting_command=="ON"){
            await (await api).scenes.activateScene(sceneID)
                .then(activated => {
                    console.log("%d - Turned ON Philips Hue scene %s",operation_num,sceneID);
                  });
          } else if (lighting_command=="OFF") {
            // Hue doesn't natively support scenes to turn OFF. Therefore, groups are used as a proxy if supplied.
            // Groups might not be supplied if the light switch controls the relevant bulbs.
            if (groupHue){
              console.log("%d - Turned OFF Philips Hue group %s",operation_num,groupHue); 
              hue_group_command (operation_num, groupHue, lighting_command);}
          }
    } catch (err) {
      console.log(`${operation_num} - ERR: Failed to execute scene command: ${err}`);
    }
  }
  

module.exports = {
  hue_group_command,
  hue_scene_command,
};