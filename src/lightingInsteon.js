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

const DRY_RUN = process.env.APOLLO_DRY_RUN === '1';

var hub_command = {
    host: process.env.INSTEON_HUB_IP,
    port: 25105,
    method: "POST",
    auth: process.env.INSTEON_USERNAME + ":" + process.env.INSTEON_PASSWORD
};


const mqttTopics = require('./mqttTopics');

// Single verification poll, scheduled 5s after an optimistic device-command
// publish (Stage 3, issue #11). Long enough for the hub to have actually
// applied the command; short enough to correct a wrong optimistic guess
// before it's stale.
const VERIFY_POLL_DELAY_MS = 5000;
const BRIGHTNESS_MISMATCH_THRESHOLD = 5;

/**
 * Tells the listener module's poll sweep to back off -- lazily required
 * (function scope, not module scope) since lighting.js is the only place
 * that currently requires both modules, and requiring lazily here avoids any
 * dependency on which of the two modules happens to load first.
 */
function noteCommandSent() {
    require('./lightingInsteonListener').noteCommandSent();
}


/* ####### INSTEON SCENE COMMAND

Usage:
insteon_scene_command('living-room','on');

*/

// Post-scene verification sweep (live-verified bug: a light stayed on after
// an "all off" scene broadcast even though most devices pick up the hub's
// own cleanup events within ~4s -- some devices simply don't respond, and
// the round-robin poll alone can take up to a minute to notice). Delayed so
// the scene broadcast's own traffic/cleanup events settle first.
const SCENE_SWEEP_DELAY_MS = 3000;

function insteon_scene_command (operation_num, scene, insteon_command) {

    /*
    PATH BREAKDOWN
    /0?       START FOR ALL COMMANDS
    11        ON=11, OFF=13
    1         SCENE ID
    =I=0      END FOR ALL COMMANDS

    */

    // Captured before the switch below overwrites insteon_command with its
    // encoded hex form -- only needed for the sweep's log line.
    const commandLabel = insteon_command;

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

    // No optimistic MQTT publish here -- a scene fans out to an unknown set of
    // member devices, so there is no single entry to publish state for; the
    // poll sweep in lightingInsteonListener.js picks up the resulting changes
    // on its own. It still occupies the hub's command buffer, though, so the
    // poll sweep must still be told to back off.
    noteCommandSent();

    insteon_send_command(operation_num, hub_command);

    scheduleSceneSweep(operation_num, scene, commandLabel);
}

/**
 * Schedules sweepAll() (lightingInsteonListener.js) SCENE_SWEEP_DELAY_MS
 * after a scene broadcast, to promptly catch any member device that didn't
 * pick up the broadcast (see SCENE_SWEEP_DELAY_MS's doc comment above).
 * Skipped entirely in DRY_RUN -- there's no real hub connection for
 * sweepAll() to poll (the listener's startListener()/hub.httpClient() is
 * never called under DRY_RUN, see index.js), so it would just spin against
 * an unconfigured `Insteon()` instance for no benefit. Lazy require +
 * defensive try/catch mirror noteCommandSent()'s existing pattern above.
 * @param {number} operation_num
 * @param {string} scene
 * @param {string} commandLabel - "ON"/"OFF", for the sweep's log line
 */
function scheduleSceneSweep(operation_num, scene, commandLabel) {
    if (DRY_RUN) {
        return;
    }

    const timer = setTimeout(function () {
        try {
            require('./lightingInsteonListener').sweepAll('scene:' + scene + ':' + commandLabel);
        } catch (err) {
            console.log("%d - Insteon post-scene sweep error: %s", operation_num, err.message);
        }
    }, SCENE_SWEEP_DELAY_MS);

    if (typeof timer.unref === 'function') {
        timer.unref();
    }
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

    // Capture the semantic meaning of the command BEFORE it gets overwritten
    // below with its encoded hex form -- this is what optimistic state
    // publishing needs, and it's only available here.
    const optimisticState = optimisticStateFor(insteon_command);

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

    // Occupies the hub's command buffer -- tell the poll sweep to back off,
    // whether or not we end up publishing optimistic state below.
    noteCommandSent();

    insteon_send_command(operation_num, hub_command);

    if (optimisticState) {
        publishOptimisticState(operation_num, address, optimisticState);
    }

}

/**
 * Maps the semantic (pre-encoding) device command to the optimistic state we
 * can immediately publish, or null for commands whose result is unknown
 * (relative BRIGHTEN/DIM) or unrecognized (encoding already logs those).
 * @param {string|number} semanticCommand - e.g. "ON", "OFF", "FAST-ON", or a 0-100 level
 * @returns {{power: string, brightness: number}|null}
 */
function optimisticStateFor(semanticCommand) {
    if (!isNaN(semanticCommand)) {
        const level = Number(semanticCommand);
        return { power: level > 0 ? 'ON' : 'OFF', brightness: level };
    }

    switch (semanticCommand) {
        case "ON":
        case "FAST-ON":
            return { power: 'ON', brightness: 100 };
        case "OFF":
        case "FAST-OFF":
            return { power: 'OFF', brightness: 0 };
        case "BRIGHTEN":
        case "DIM":
        default:
            // BRIGHTEN/DIM are relative -- the resulting level is unknown until
            // polled, so skip the optimistic publish. Unrecognized commands
            // already returned earlier in insteon_device_command.
            return null;
    }
}

/**
 * Publishes optimistic (source:"command") state immediately, then schedules a
 * single verification poll 5s later. If the poll disagrees (different power,
 * or brightness differing by more than 5 points), the polled truth is
 * published instead (source:"poll"). Errors during verification are logged
 * and never thrown. Skipped entirely in DRY_RUN, since there is no real hub
 * connection to verify against.
 * @param {number} operation_num
 * @param {string} address - hex device address
 * @param {{power: string, brightness: number}} state
 */
function publishOptimisticState(operation_num, address, state) {
    const entry = findLightByAddress(address);
    if (!entry) {
        return;
    }

    mqttTopics.publishState(entry, state, 'command');

    if (DRY_RUN) {
        return; // No real hub connection to verify against.
    }

    setTimeout(function () {
        verifyDeviceState(operation_num, entry, state);
    }, VERIFY_POLL_DELAY_MS);
}

/**
 * Looks up a lights.json entry of type "insteon" by its hex address, matched
 * case-insensitively. Lazily requires ../index (same load-order rule as every
 * other src/ module) and lightingInsteonListener.js (for hub access) only
 * when actually needed, to avoid any load-order issues at require time.
 * @param {string} address
 * @returns {object|null}
 */
function findLightByAddress(address) {
    const index = require('../index');
    const lights = index.lights || [];
    const upperAddress = String(address).toUpperCase();
    for (const light of lights) {
        if (light.type === 'insteon' && light.address && light.address.toUpperCase() === upperAddress) {
            return light;
        }
    }
    return null;
}

/**
 * Polls the device's actual level via the hub (reusing the listener module's
 * connection -- see getHub()) and, if it disagrees with the optimistic guess,
 * publishes the polled truth. Never throws -- logs and returns on any error.
 * @param {number} operation_num
 * @param {object} entry
 * @param {{power: string, brightness: number}} optimisticState
 */
function verifyDeviceState(operation_num, entry, optimisticState) {
    let hub;
    try {
        hub = require('./lightingInsteonListener').getHub();
        const result = hub.light(entry.address).level();
        Promise.resolve(result).then(function (lvl) {
            const level = (typeof lvl === 'number') ? lvl : 0;
            const power = level > 0 ? 'ON' : 'OFF';

            const powerMismatch = power !== optimisticState.power;
            const brightnessMismatch = Math.abs(level - optimisticState.brightness) > BRIGHTNESS_MISMATCH_THRESHOLD;

            if (powerMismatch || brightnessMismatch) {
                mqttTopics.publishState(entry, { power, brightness: level }, 'poll');
                entry.checked = (power === 'ON');
                entry.status = level;
            }
        }).catch(function (err) {
            console.log("%d - Insteon verification poll error: %s", operation_num, err.message);
        });
    } catch (err) {
        console.log("%d - Insteon verification poll error: %s", operation_num, err.message);
    }
}


function insteon_send_command (operation_num, command){

    console.log("%d - Sending Command: %s", operation_num, command['path']);

    if (DRY_RUN) {
        console.log("%d - DRY RUN, would send Insteon command: %s", operation_num, command['path']);
        return;
    }

    var req = http.request(command, function(response) {
      var str = '';

      response.on('data', function (chunk) {
        str += chunk;
      });

      response.on('end', function () {
        // Add error handling for no response
        // console.log(str);
      });
    });

    req.on('error', function(err) {
      console.log("%d - Insteon command error: %s", operation_num, err.message);
    });

    req.end();

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

    // Lazily required (function scope, not module scope) so merely requiring
    // this module doesn't boot index.js -- same load-order rule as
    // findLightByAddress() below.
    const { lightingScenes } = require('../index');
    const lighting_scenes = lightingScenes;

    var sceneInsteon = false;
    for(var i = 0; i < lighting_scenes.length; i++) {
        if(lighting_scenes[i].id == sceneID) {
            sceneInsteon =   lighting_scenes[i].insteon_group || false;
        }
      }

    if (!sceneInsteon) {
        console.log("%d - ERR: No matching scene found for blink: %s", operation_num, sceneID);
        return;
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
    insteon_button_blink,
    optimisticStateFor,
  };
