/**
 * Apollo Home Control Bridge - Alexa AC Module
 * @module alexaAC.js
 * 
 * @author Ray Perfetti
 * @date 2021-10-05
 * 
 * @description     Handles device commands for Alexa Smart Home Skill ThermostatController
 *                  Temperature and Mode can be controlled
 * 
 */



/*

Alex Innvocation Syntax                             Payload Value

Alexa, increase the AC temperature by 3 degrees.    
Alexa, decrease the AC temperature by 3 degrees.    
Alexa, increase the AC temperature.                 2
Alexa, decrease the AC temperature.                 -2

*/

const { send_serial_command,                    // Serial Modules RS-232
        send_ir_command,                        // Infrared (IR)
        send_cc_command }                       // Contact Closure (CC)
        = require('./iTachControllers');        // iTach Modules

/**
 * Scans a device's commands object for a key matching commandId, case-insensitively.
 * Mirrors handler.js's extractCommand(), duplicated locally to avoid a circular
 * require (handler.js already requires this module).
 * @param {object} device - The device object containing the commands.
 * @param {string} commandId - The command key to look up.
 * @returns {string|false} - The command value if found, otherwise false.
 */
function extractCommand(device, commandId) {
    let curExecute = false;
    commandId = commandId.toUpperCase();
    for (const key in device.commands) {
        if (key && key.toUpperCase() === commandId) {
            curExecute = device.commands[key];
        }
    }
    return curExecute;
}

function alexaAC(debugId, curDevice, apiCommand, apiParam1) {

    let curExecute = "";
    let curDirection = "";
    switch(apiCommand.toUpperCase()) {

        case 'ADJUSTTARGETTEMPERATURE':
            apiParam1 = parseInt(apiParam1); //Convert to integer

            if(apiParam1 > 0) {
                curDirection = "temp_increase";
            } else {
                curDirection = "temp_decrease";
                apiParam1 = apiParam1 * -1;
            }

            if(apiParam1 > 5) {
                console.log("%d - WARNING: Can not change by %s. Adjusting to max.", debugId, apiParam1);
                apiParam1 = 5; // Max 5 degrees
            }

            curExecute = curDevice.commands[curDirection]; // At least 1 command
            for (let i = 1; i < apiParam1; i++) {
                curExecute += "~" + curDevice.commands[curDirection]; // Add additional degrees
            }

            break;

        case 'SETTHERMOSTATMODE':
            if(apiParam1 == 'ECO' || apiParam1 == 'COOL') {
                // Case-insensitive lookup -- some device configs (e.g. bedroom AC) use
                // lowercase command keys ("cool") instead of the uppercase Alexa payload value.
                curExecute = extractCommand(curDevice, apiParam1);
                if (!curExecute && apiParam1 == 'ECO') {
                    // Alias: the bedroom AC config names this command "energy_saver" instead of "eco".
                    curExecute = extractCommand(curDevice, 'energy_saver');
                }
                if (!curExecute) {
                    console.log("%d - ERROR: No command configured for thermostat mode %s", debugId, apiParam1);
                    return;
                }
            } else {
                console.log("%d - ERROR: Unknown thermostat mode %s", debugId, apiCommand);
                return;
            }
            break;

        default:
            console.log("%d - ERROR: Unknown command %s", debugId, apiCommand);
            return;
    }

    if (curExecute) {
        send_ir_command(curDevice.address,curExecute,debugId);
    } else {
        console.log("%d - ERROR: No command to send for %s", debugId, apiCommand);
    }

}

module.exports = {
    alexaAC
}