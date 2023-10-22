/**
 * Apollo Home Control Bridge - Insteon Module
 * @module lightingInsteon.js
 * 
 * @author Ray Perfetti
 * @date 2023-10-08
 * 
 * @description  Controls lighting fixtures and scenes on the Insteon platform
*                with the ability to turn on/off, dim, and execute scenes.
*
*                The raw Insteon message format is encoded and sent to the Insteon Hub via an HTTP request.
*                While rudimentary, this approach is reliable, fast, and fully local.
*                This function does not require Insteon's paid cloud service and does not access to internet.
*
*                Dependencies:
*                - Insteon Hub (tested with 2245-222)   
*/


// HTTP MODULE FOR SENDING DEVICE COMMANDS
var http = require('http');


var hub_command = {
    host: process.env.INSTEON_HUB_IP,
    port: 25105,
    method: "POST",
    auth: process.env.INSTEON_USERNAME + ":" + process.env.INSTEON_PASSWORD
};


// Needed exclusively for insteon_button_blink
const { lightingScenes }                                  
        = require('../index');
const lighting_scenes = lightingScenes;


/* ####### INSTEON SCENE COMMAND

Usage:
insteon_scene_command('living-room','on');

*/

function insteon_scene_command (operation_num, scene, insteon_command) {

    /*
    PATH BREAKDOWN
    /0?       START FOR ALL COMMANDS
    11        ON=11, OFF=13
    1         SCENE ID
    =I=0      END FOR ALL COMMANDS
    
    */

    switch(insteon_command) {

      case "ON":
        insteon_command="11";
        break;
      case "OFF":
        insteon_command="13";
        break;
      default:
         console.log("%d - ERR: Command Not Recognized: %s", operation_num, insteon_command);
         return;
    }

    hub_command['path'] = '/0?' + insteon_command + scene + '=I=0';


    insteon_send_command(operation_num, hub_command);
}


function insteon_device_command(operation_num, address, insteon_command) {
    /*
    PATH BREAKDOWN
    /3?0262   START FOR ALL COMMANDS
    2A2A2A    DEVICE ID
    0F        The flags for this message. All standard message commands should have 0F for the flags.
    12        the command (See Ref Table)
    80        the command parameter (See Brightness Table)
    =I=3      END FOR ALL COMMANDS

    COMMAND REFERENCE
    11        On - Can Be used with Variable to set default brightness level
    12        Fast On - Will go immediately to full brightness - No ramp rate
    13        Off - Can Be used with Variable to set default brightness level
    14        Fast Off - Will go immediately off - No ramp rate
    15        Brighten - Incrementally increase brightness of a dimmable device
    16        Dim - Incrementally decrease brightness of a dimmable device

    BRIGHTNESS REFERENCE
    0         0%
    19        10%
    40        25%
    7F        50%
    BF        75%
    E6        90%
    FF        100%
    */

    // If a number is provided, it should dim to that level
    if (!isNaN(insteon_command)) {
        insteon_command = "11" + levelToHexByte(insteon_command);
    } else {

        //If text is provided, check for standard on / off commands
        switch (insteon_command) {

            case "ON":
                insteon_command = "11FF";
                break;
            case "FAST-ON":
                insteon_command = "12FF";
                break;
            case "OFF":
                insteon_command = "1300";
                break;
            case "FAST-OFF":
                insteon_command = "1400";
                break;
            case "BRIGHTEN":
                insteon_command = "15FF";
                break;
            case "DIM":
                insteon_command = "1600";
                break;
            default:
                console.log("%d - ERR: Command Not Recognized: %s", operation_num, insteon_command);
                return;
        }
    }

    hub_command['path'] = '/3?0262' + address + '0F' + insteon_command + '=I=3';

    insteon_send_command(operation_num, hub_command);

}


function insteon_send_command (operation_num, command){

    console.log("%d - Sending Command: %s", operation_num, command['path']);

    http.request(command, function(response) {
      var str = '';

      response.on('data', function (chunk) {
        str += chunk;
      });

      response.on('end', function () {
        // Add error handling for no response
        // console.log(str);
      });
    }).end();

}



/* ####### INSTEON BUTTON BLINK
          Blinks the button on a Keypad Linc 2 times.
          This creates feedback for the user that the command was recognized and ends the button state OFF
          so that the keypad is ready for the next command. Otherwise, the button would be left of on-state and
          pressing again would send the OFF command incorrectly.
          Button must be linked to a scene ID via the Insteon Hub and passed as a parameter.

          Alternative approach may be to toggle these buttons when other modes or scenes are run.
          Interval of 1.5s was tested as max speed of blink

Usage:
insteon_button_blink(operation_num,'button-a');

*/
function insteon_button_blink(operation_num, sceneID) {

    for(var i = 0; i < lighting_scenes.length; i++) {
        if(lighting_scenes[i].id == sceneID) {
            var sceneInsteon =   lighting_scenes[i].insteon_group || false;
        }
      }

    insteon_scene_command (operation_num, sceneInsteon, "OFF");
    setTimeout(function () { insteon_scene_command (operation_num, sceneInsteon, "ON"); }, 1500);
    setTimeout(function () { insteon_scene_command (operation_num, sceneInsteon, "OFF"); }, 3000);
    setTimeout(function () { insteon_scene_command (operation_num, sceneInsteon, "ON"); }, 4500);
    setTimeout(function () { insteon_scene_command (operation_num, sceneInsteon, "OFF"); }, 6000);

}


/* ####### VALUE CONVERSION UTILITIES

*/

function levelToHexByte(level) {
    if (level < 0 || level > 100) {
      throw new Error('level must be between 0 and 100');
    }
    // scale level to a max of 0xFF (255)
    level = ~~ (255 * level / 100);
  
    return toByte(level);
  
  }
  
  function toByte(value, length) {
    length = length || 1;
    value = value.toString(16).toUpperCase();
    var pad = new Array((length * 2) + 1).join('0');
    return pad.substring(0, pad.length - value.length) + value;
  }
  
  

module.exports = {
    insteon_device_command,
    insteon_scene_command,
    insteon_button_blink
  };