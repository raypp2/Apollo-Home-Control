/**
 * Apollo Home Control Bridge - Lighting Module
 * @module lighting.js
 * 
 * @author Ray Perfetti
 * @date 2023-10-08
 * 
 * @description   Controls lighting fixtures and scenes on the Insteon and Philips Hue platforms
 *                with the ability to turn on/off, dim, and execute scenes.
 * 
 *                Status Monitoring (Listener)
 *                In addition to activating devices and scenes, it can monitor the status of devices on Insteon.
 *                This status polling is used to update the status of the device in the UI.
 * 
 *                KeyPad Linc Features
 *                Responds to a Keypad Linc button press by executing a command.
 *                Feedback can be provided to the user by blinking the button twice.
 * 
 *                Developer Note
 *                The home-controller module is used for device polling but not for device control.
 *                This is because my legacy code works reliably with my Insteon Hub.
 *                Home-controller may be a better option for others but, in my case, if it ain't broke, don't fix it.
 * 
 *                Dependencies:
 *                - Insteon Hub (tested with 2245-222)
 *                - Philips Hue Bridge (tested with model 3241312018A)
 *                - home-controller by Automate Green (Brandon Goode)
 *                - node-hue-api by Peter Murray
 * 
 */

'use strict';


const { insteonListenerStart }                              // Insteon Listener module
= require('./lightingInsteonListener');  


const { insteon_device_command,                                 // Insteon lighting module
        insteon_scene_command }
         = require('./lightingInsteon.js');
const { hue_group_command,                                      // Philips Hue lighting module        
        hue_scene_command }
         = require('./lightingPhilipsHue.js');
const { dmx_scene_command,
        dmx_fixture_command }
          = require('./lightingDmx');


// Load variables
const { devices, deviceScenes, lights, lightingScenes, macros, logging }                                  
        = require('../index');

const lights_new = lights;
const lighting_scenes = lightingScenes;


function lighting_device_command (operation_num, device, lighting_command) {
  for(var i = 0; i < lights_new.length; i++) {
    if(lights_new[i].id.toUpperCase() == device.toUpperCase()) {
      switch(lights_new[i].type) {
        case 'insteon':
          insteon_device_command(operation_num, lights_new[i].address, lighting_command);
          if(lighting_command=="OFF"){
              lights_new[i].checked = false;
              lights_new[i].status = 0;
          } else if(lighting_command=="ON"){
              lights_new[i].checked = true;
              lights_new[i].status = 100;
          }
          break;
        case 'hue-group':
          console.log("%d - Turning Philips Hue group #%s to %s",operation_num, lights_new[i].address, lighting_command);
          hue_group_command(operation_num, lights_new[i].address, lighting_command);
          break;
        case 'dmxFixture':
          console.log("%d - Setting DMX Fixture %s to preset %s with command %s",operation_num, lights_new[i].fixture, lights_new[i].id, lighting_command);
          dmx_fixture_command(operation_num, lights_new[i].fixture, lights_new[i].id, lighting_command);
          break;
        default:
          console.log("%d - ERR: Light Type Not Recognized: %s", operation_num, lights_new[i].type);
          return;
      }
    }
  }

}

function scene_command (operation_num, sceneID, lighting_command) {
  for(var i = 0; i < lighting_scenes.length; i++) {
    if(lighting_scenes[i].id.toUpperCase() == sceneID.toUpperCase()) {
      var sceneTitle =     lighting_scenes[i].title;
      var sceneInsteon =   lighting_scenes[i].insteon_group || false;
      var sceneHue =       lighting_scenes[i].hue_scene     || false;
      var groupHue =       lighting_scenes[i].hue_group     || false;
      var sceneDMX =       lighting_scenes[i].dmx_scene     || false;
      if (sceneInsteon){
        insteon_scene_command (operation_num, sceneInsteon, lighting_command);
      }
      if (sceneHue) {
        if (Array.isArray(sceneHue)) {
            //console.log("%d - Executing hue ARRAY scene.",operation_num);
            sceneHue.forEach(function(sceneHue_x) {
                hue_scene_command (operation_num, sceneHue_x, lighting_command, groupHue);
            });
        } else {
            //console.log("%d - Executing hue individual scene.",operation_num);
            hue_scene_command (operation_num, sceneHue, lighting_command, groupHue);
        }
      } else if(groupHue){
        // This falls back to a group if there is not a scene. Ex: All Lights

        //console.log("%d - Executing hue group.",operation_num);
        hue_group_command(operation_num, groupHue, lighting_command);
      }
      if (sceneDMX) {
        console.log("%d - Setting DMX scene %s to command %s",operation_num, sceneDMX, lighting_command);
        dmx_scene_command(operation_num, sceneDMX, lighting_command);
      }
    }
  }
}

module.exports = {
  lighting_device_command,
  scene_command
};