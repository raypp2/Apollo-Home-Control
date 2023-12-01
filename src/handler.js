/**
 * Apollo Home Control Bridge - Handler Module
 * @module handler.js
 * 
 * @author Ray Perfetti
 * @date 2021-10-05
 * 
 * @description Processes commands received via API or SQS.
 *              Commands are routed to the appropriate modules.
 *              Conveniece functions, such as macros and device scenes,
 *              which combine multiple functions.
 * 
 * @exports handleRequest
 * 
 */


// Load variables
const { devices, deviceScenes, lights, lightingScenes, macros, logging }                                  
        = require('../index');

const { lighting_device_command,                // Lighting Modules
        scene_command }
        = require('./lighting'); 

const { insteon_button_blink }                  // Insteon Keypad Blink
        = require('./lightingInsteon');

const { send_serial_command,                    // Serial Modules RS-232
        send_ir_command,                        // Infrared (IR)
        send_cc_command }                       // Contact Closure (CC)
        = require('./iTachControllers');        // iTach Modules

const { send_ip_command }                       // IP Devices
        = require('./tcpServers');

const { send_somfy_command }                    // Somfy Shades
        = require('./somfyBridge');

const { spotifySwitchPlay,                      // Spotify Playback Control
        spotifyStopPlay }                     
        = require('./spotify');

const { find_my_iphone_alert }                  // Find My iPhone Alert
        = require('./findMy');

const { alexaSpeaker }                          // Alexa Speaker
        = require('./alexaSpeaker');

const { alexaAC }                               // Alexa AC
        = require('./alexaAC');

/**
 * Handles incoming API or SQS commands and routes them to the appropriate handler functions.
 * @param {String} request - The command in format "/module/device/command/param1/param2"
 * @param {Object} response - The HTTP response object.
 */
function handleRequest(request, response){

	logging.operation_num++; // For debug tracking
	console.log("%d - Received Command: %s", logging.operation_num, request);

    const api = request.split("/");
    const apiModule     = api[1] ? api[1].toUpperCase() : false;
    const apiDevice     = api[2] ? api[2].toUpperCase() : false;
    const apiCommand    = api[3] ? api[3].toUpperCase() : false;
    const apiParam1     = api[4] ? api[4].toUpperCase() : false;
    const apiParam2     = api[5] ? api[5].toUpperCase() : false;

    if(!apiModule || !apiDevice) {
        //response.status(404).send("ERROR: You must specify a valid API command -- /api/module/device/command/param1/param2");
        console.log("ERROR: You must specify a valid API command -- /api/module/device/command/param1/param2");
        return;
    }

    // console.log("API Module: " + apiModule);
    // console.log("API Device: " + apiDevice);
    // console.log("API Command: " + apiCommand);
    // console.log("API Param1: " + apiParam1);
    // console.log("API Param2: " + apiParam2);

    switch(apiModule) {

        // Handle Device Commands
        case "DEVICES":
            handleDevice(logging.operation_num, apiDevice, apiCommand, apiParam1, apiParam2, response);
            return;

        case "DEVICESCENES":
            handleDeviceScene(logging.operation_num, apiDevice, apiCommand, response);
            return;
        
        case "LIGHTS":
            lighting_device_command(logging.operation_num, apiDevice, apiCommand);
            return;

        case "LIGHTINGSCENES":
            scene_command (logging.operation_num, apiDevice, apiCommand);
            return;

        case "MACROS":
            handleMacro(logging.operation_num, apiDevice, apiCommand, response);
            return;
        
        case "SPEAKERS":
            handleSpeaker(logging.operation_num, apiDevice, apiCommand, apiParam1, apiParam2, response);
            return;
        
        case "AC":
            handleAC(logging.operation_num, apiDevice, apiCommand, apiParam1, response);
            return;
        
        case "LOCKS":
            console.log("Lock module found");
            handleDoor(logging.operation_num, apiDevice, apiCommand, apiParam1, response);
            return;

        default:
            console.log("%d - Error: Module not valid", logging.operation_num);
            // TODO: Setup promises to return error to browser
            // response.status(404).send("ERROR: You must specify a valid module -- devices, deviceScenes, lights, lightingScenes, or macros.")
    }

}




/**
 * Handles a device command request.
 *
 * @param {number} debugId - A debug number that allows us to trace a command in the console log.
 * @param {string} apiDevice - The device ID as specified in the device.json file.
 * @param {string} apiCommand - The command to execute for the device.
 * @param {string} apiParam1 - (optional) The first parameter for the command.
 * @param {string} apiParam2 - (optional) The second parameter for the command.
 * @param {Object} response - (optional) The response object to return a status via the api.
 */
function handleDevice(debugId, apiDevice, apiCommand, apiParam1, apiParam2, response) {

    // Search for the device
    let curDevice = extractDevice(apiDevice);
    if(!curDevice) {
        console.log("%d - Device not found", debugId);
        // response.status(404).send("ERROR: Device not found.")
        return;
    }

    // Search for the command
    let curExecute = extractCommand(curDevice, apiCommand);
    if(!curExecute) {
        console.log("%d - Command not found", debugId);
        // response.status(404).send("ERROR: Command not found.")
        return;
    }
    
    console.log("%d - API Device ID: %s", debugId, apiDevice);
    console.log("%d - API Command: %s", debugId, apiCommand);
    console.log("%d - API Param1: %s", debugId, apiParam1);
    console.log("%d - API Param2: %s\n", debugId, apiParam2);

    console.log("%d - Device title: %s", debugId, curDevice.title);
    console.log("%d - Device type: %s", debugId, curDevice.type);
    console.log("%d - Device address: %s", debugId, curDevice.address);
    console.log("%d - Device Port: %s", debugId, curDevice.port);
    console.log("%d - Device Power Commands: %s", debugId, curDevice.power_commands);
    console.log("%d - Device Execute: %s\n", debugId, curExecute);

    const nextDebugId = logging.operation_num;

    switch(curDevice.type) {
        case "iTach_serial":
            console.log("%d - iTach serial device found", nextDebugId);
            send_serial_command(curDevice.address,curExecute,nextDebugId);
            break;
        case "iTach_ir":
            console.log("%d - iTach IR device found", nextDebugId);
            send_ir_command(curDevice.address,curExecute,nextDebugId);
            break;
        case "iTach_CC":
            console.log("%d - iTach Contact Closure device found", nextDebugId);
            send_cc_command(curDevice.address,curExecute,nextDebugId);
            break;
        case "ip_control":
            console.log("%d - IP Control device found", nextDebugId);
            send_ip_command(nextDebugId, curDevice, curExecute, false);
            break;
        case "findMyIphone":
            console.log("%d - Find My iPhone device found", nextDebugId);
            find_my_iphone_alert(process.env.icloudDeviceID, nextDebugId);
            break;
        case "Somfy-Bridge":
            console.log("%d - Somfy Bridge device found", nextDebugId);

            // Via the web interface, the ON and OFF commands should pass through as 
            // the parameter as if they were received via the API.
            if(apiCommand=="OFF"){
                apiParam1="OFF";
            }else if(apiCommand=="ON"){
                apiParam1="ON";
            }
            
            send_somfy_command(curDevice.address,curExecute,apiParam1,nextDebugId);
            break;
        case "spotify":
            console.log("%d - Spotify device found", nextDebugId);
            if(apiCommand=="ON") {
                spotifySwitchPlay(curDevice.address,false,nextDebugId);
            } else if(apiCommand=="OFF") {
                spotifyStopPlay(curDevice.address,nextDebugId);
            } else {
                spotifySwitchPlay(curDevice.address,curExecute,nextDebugId);
            }
            break;
        default:
            console.log("%d - Device type not found", nextDebugId);
            if (typeof response != 'undefined') { response.status(404).send("ERROR: Device type not found."); }
            return;
    }

    // Respond with something to kill connection
    if (typeof response != 'undefined') { response.end("Completed processing request."); } 

}   

/**
 * Handles a device scene command request. 
 * This is a convenience function that turns on and sets the input for an audio device, 
 * turns on a video device, sets a lighting scene, and blinks a button.
 *
 * @param {number} debugId - A debug number that allows us to trace a command in the console log.
 * @param {string} apiDevice - The device scene ID as specified in the device.json file.
 * @param {string} apiCommand - The command to execute for the device.
 * @param {Object} response - (optional) The response object to return a status via the api.
 */
function handleDeviceScene(debugId, apiDevice, apiCommand, response) {

    console.log("%d - Turning Device Scene: %s", logging.operation_num, apiCommand);

    // Search for the device scene
    let curDeviceScene;
    for (const deviceScene of deviceScenes) {
        if (deviceScene.id && deviceScene.id.toUpperCase() === apiDevice) {
            curDeviceScene = deviceScene;
        }
    }
    
    if(!curDeviceScene) {
        console.log("%d - Device scene not found", debugId);
        // response.status(404).send("ERROR: Device or command not found.")
        return;
    }


    // Search for the audio device
    let curAudio, curAudioInput, curAudioOff;
    if(curDeviceScene.audioDevice && curDeviceScene.audioInput){

        // Search for the device
        curAudio = extractDevice(curDeviceScene.audioDevice);
        if(!curAudio) {
            console.log("%d - Audio device not found", debugId);
            // response.status(404).send("ERROR: Device not found.")
            return;
        }

        // Search for the command
        curAudioInput = extractCommand(curAudio, curDeviceScene.audioInput);
        curAudioOff = extractCommand(curAudio, "OFF");
        if(!curAudioInput || !curAudioOff) {
            console.log("%d - Audio command not found", debugId);
            // response.status(404).send("ERROR: Command not found.")
            return;
        }
    }

    // Run audio commands
    if(curAudio){
        if(apiCommand=="OFF"){
            console.log("%d - Turning off audio device: %s", debugId, curAudio.title);
            send_ip_command(debugId, curAudio, curAudioOff, true);
        } else {
            console.log("%d - Switching audio device %s input: %s", debugId, curAudio.title, curDeviceScene.audioInput);
            send_ip_command(debugId, curAudio, curAudioInput, true);
        }
    }

    // Search for the video device
    let curVideo, curVideoOn, curVideoOff;
    if(curDeviceScene.videoDevice){

        // Search for the device
        curVideo = extractDevice(curDeviceScene.videoDevice);
        if(!curVideo) {
            console.log("%d - Video device not found", debugId);
            // response.status(404).send("ERROR: Device not found.")
            return;
        }

        // Search for the command
        curVideoOn = extractCommand(curVideo, "ON");
        curVideoOff = extractCommand(curVideo, "OFF");
        if(!curVideoOn || !curVideoOff) {
            console.log("%d - Video command not found", debugId);
            // response.status(404).send("ERROR: Command not found.")
            return;
        }
    }

    // Run video commands
    if(curVideo){
        debugId++; // Track as a new debug id
        if(apiCommand=="OFF"){
            console.log("%d - Turning off video device: %s", debugId, curVideo.title);
            send_ip_command(debugId, curVideo,curVideoOff, true);
        } else {
            console.log("%d - Turning on video device: %s", debugId, curVideo.title);
			send_ip_command(debugId, curVideo,curVideoOn, false);
        }
    }
    
    // Run Lighting Scene
    if(curDeviceScene.lightingScene){
        scene_command(debugId++, curDeviceScene.lightingScene, apiCommand);
    }

    /*
    // TODO Fix Blinking Button Functions
    // Run Blinking Button Scene
    if(curDeviceScene.blinkButton){
        insteon_button_blink(debugId++,curDeviceScene.blinkButton);
    }
    */
}




/**
 * Handles a macro command request. 
 * This is a convenience function that runs multiple commands.
 *
 * @param {number} debugId - A debug number that allows us to trace a command in the console log.
 * @param {string} apiDevice - The device scene ID as specified in the device.json file.
 * @param {string} apiCommand - The command to execute for the device.
 * @param {Object} response - (optional) The response object to return a status via the api.
 */
function handleMacro(debugId, apiDevice, apiCommand, response) {
    console.log("%d - Macro command received", debugId);

    // Search for the macro
    let macro_commands;
    let passOnOff=false;
    for (const macro of macros) {
        if (macro.id && macro.id.toUpperCase() === apiDevice) {
          macro_commands = macro.commands;
          passOnOff = macro.passOnOff;
        }
    }
    
    if(!macro_commands) {
        console.log("%d - Macro commands not found", debugId);
        // response.status(404).send("ERROR: Device or command not found.")
        return;
    }

    // Run each command in the macro
    for (var i=0; i < macro_commands.length; i++) {
            // console.log("%d - Running Command: %s", debugId, macro_commands[i]);
            if(passOnOff){
                handleRequest("/"+macro_commands[i]+"/"+apiCommand);
            } else {
                handleRequest("/"+macro_commands[i]);
            }
    }

    // Respond with something to kill connection
    if (typeof response != 'undefined') { response.end("Completed processing request."); } 
}


/**
 * Handles a speaker device command request.
 *
 * @param {number} debugId - A debug number that allows us to trace a command in the console log.
 * @param {string} apiDevice - The device ID as specified in the device.json file.
 * @param {string} apiCommand - [SETVOLUME, ADJUSTVOLUME, SETMUTE, OTHER] The command to execute for the device.
 * @param {string} apiParam1 - (optional) The first parameter for the command.
 * @param {string} apiParam2 - (optional) The second parameter for the command.
 * @param {Object} response - (optional) The response object to return a status via the api.
 */
function handleSpeaker(debugId, apiDevice, apiCommand, apiParam1, apiParam2, response) {

    // Search for the device
    let curDevice = extractDevice(apiDevice);
    if(!curDevice) {
        console.log("%d - Device not found", debugId);
        // response.status(404).send("ERROR: Device not found.")
        return;
    }

    // Search for the command
    let curExecute = extractCommand(curDevice, apiCommand);

    console.log("%d - API Device ID: %s", debugId, apiDevice);
    console.log("%d - API Command: %s", debugId, apiCommand);
    console.log("%d - API Param1: %s", debugId, apiParam1);
    console.log("%d - API Param2: %s\n", debugId, apiParam2);

    console.log("%d - Device title: %s", debugId, curDevice.title);
    console.log("%d - Device type: %s", debugId, curDevice.type);
    console.log("%d - Device address: %s", debugId, curDevice.address);
    console.log("%d - Device Port: %s", debugId, curDevice.port);
    console.log("%d - Device Power Commands: %s", debugId, curDevice.power_commands);
    console.log("%d - Device Execute: %s\n", debugId, curExecute);

    if(!curExecute) {
        if (apiCommand.toUpperCase() == "SETVOLUME" || apiCommand.toUpperCase() == "ADJUSTVOLUME" || apiCommand.toUpperCase() == "SETMUTE") {
            console.log("%d - Speaker device command", debugId);
            alexaSpeaker(logging.operation_num, curDevice, apiCommand, apiParam1, apiParam2);
        } else {
            console.log("%d - ERROR: Unknown command %s", debugId, apiCommand);
            // response.status(404).send("ERROR: Command not found.")
        }
        return;
    }

    // Process as a standard device command
    send_ip_command(logging.operation_num, curDevice, curExecute, false);
    return; 
    
}

/**
 * Handles the Alexa lock command.
 * @param {number} debugId - The debug ID.
 * @param {string} apiDevice - The API device ID.
 * @param {string} apiCommand - The API command.
 * @param {object} response - The response object.
 */
function handleDoor(debugId, apiDevice, apiCommand, apiParam1, response) {

    // Search for the device
    let curDevice = extractDevice("door");
    if(!curDevice) {
        console.log("%d - Door device not found", debugId);
        // response.status(404).send("ERROR: Device not found.")
        return;
    }

    // Search for the command
    let curExecute = extractCommand(curDevice, apiCommand);
    if(!curExecute) {
        console.log("%d - Command not found", debugId);
        // response.status(404).send("ERROR: Command not found.")
        return;
    }

    console.log("%d - API Device ID: %s", debugId, apiDevice);
    console.log("%d - API Command: %s", debugId, apiCommand);

    console.log("%d - Device title: %s", debugId, curDevice.title);
    console.log("%d - Device type: %s", debugId, curDevice.type);
    console.log("%d - Device address: %s", debugId, curDevice.address);
    console.log("%d - Device Execute: %s\n", debugId, curExecute);

    if (apiParam1.toUpperCase() == "UNLOCK") {
        console.log("%d - Door unlock command", debugId);
        send_cc_command(curDevice.address,curExecute,logging.operation_num);
    } else {
        console.log("%d - ERROR: Unknown command %s", debugId, apiCommand);
        // response.status(404).send("ERROR: Command not found.")
    }

}

function handleAC(debugId, apiDevice, apiCommand, apiParam1, response) {

    // Search for the device
    let curDevice = extractDevice(apiDevice);
    if(!curDevice) {
        console.log("%d - Device not found", debugId);
        // response.status(404).send("ERROR: Device not found.")
        return;
    }

    // Search for the command
    let curExecute = extractCommand(curDevice, apiCommand);

    console.log("%d - API Device ID: %s", debugId, apiDevice);
    console.log("%d - API Command: %s", debugId, apiCommand);
    console.log("%d - API Param1: %s", debugId, apiParam1);

    console.log("%d - Device title: %s", debugId, curDevice.title);
    console.log("%d - Device type: %s", debugId, curDevice.type);
    console.log("%d - Device address: %s", debugId, curDevice.address);
    console.log("%d - Device Port: %s", debugId, curDevice.port);
    console.log("%d - Device Execute: %s\n", debugId, curExecute);

    if(!curExecute) {
        if (apiCommand.toUpperCase() == "ADJUSTTARGETTEMPERATURE") {
            console.log("%d - Adjust AC temperature by %s", debugId, apiParam1);
            alexaAC(logging.operation_num, curDevice, apiCommand, apiParam1);

        } else if (apiCommand.toUpperCase() == "SETTHERMOSTATMODE") {
            console.log("%d - Change AC mode to %s", debugId, apiParam1);
            alexaAC(logging.operation_num, curDevice, apiCommand, apiParam1);

        } else {
            console.log("%d - ERROR: Unknown command %s", debugId, apiCommand);
            // response.status(404).send("ERROR: Command not found.")
        }
        return;
    }

    // Process as a standard device command
    send_ir_command(curDevice.address,curExecute,logging.operation_num);
    return;
}

/**
 * Extracts a device object from the devices array based on the provided device ID.
 * @param {string} deviceId - The ID of the device to extract.
 * @returns {object|boolean} - The device object if found, otherwise false.
 */
function extractDevice(deviceId) {
    let curDevice = false;
    deviceId = deviceId.toUpperCase();
    for (const device of devices) {
        if (device.id && device.id.toUpperCase() === deviceId) {
          curDevice = device;
        }
    }
    return curDevice;
}

/**
 * Extracts the command from the given device object based on the provided command ID.
 * @param {object} device - The device object containing the commands.
 * @param {string} commandId - The ID of the command to extract.
 * @returns {function|boolean} - The extracted command function or false if not found.
 */
function extractCommand(device, commandId) {
    let curExecute = false;
    commandId = commandId.toUpperCase();
    for (const key in device.commands) {
        if (key && key.toUpperCase() === commandId) {
          // Command found, return the key value
          curExecute = device.commands[key];
        }
      }
    return curExecute;
}




module.exports = {
	handleRequest
};