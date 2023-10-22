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

let api;

async function initializeApi() {
  if (!api) {
    api = await v3.api.createLocal(hue_controller.host).connect(hue_controller.username);
  }
  return api;
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