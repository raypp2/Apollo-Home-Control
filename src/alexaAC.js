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

const { api } = require('node-hue-api');
const { send_serial_command,                    // Serial Modules RS-232
        send_ir_command,                        // Infrared (IR)
        send_cc_command }                       // Contact Closure (CC)
        = require('./iTachControllers');        // iTach Modules



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
            for (i = 1; i < apiParam1; i++) {
                curExecute += "~" + curDevice.commands[curDirection]; // Add additional degrees
            }

            break;

        case 'SETTHERMOSTATMODE':
            if(apiParam1 == 'ECO' || apiParam1 == 'COOL') {
                curExecute = curDevice.commands[apiParam1];
            } else {
                console.log("%d - ERROR: Unknown thermostat mode %s", debugId, apiCommand);
            }
            break;

        default:
            console.log("%d - ERROR: Unknown command %s", debugId, apiCommand);
    }

    send_ir_command(curDevice.address,curExecute,debugId);
    
}

module.exports = {
    alexaAC
}