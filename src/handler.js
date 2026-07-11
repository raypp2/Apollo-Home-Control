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
        spotifyStopPlay,
        spotifyResume }
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
        console.log("ERROR: You must specify a valid API command -- /api/module/device/command/param1/param2");
        if (typeof response != 'undefined') { response.status(400).send("ERROR: You must specify a valid API command."); }
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
            // apiParam1 carries the hex for a COLOR command
            // (/api/LIGHTS/<id>/COLOR/<hex>); ignored by other commands.
            lighting_device_command(logging.operation_num, apiDevice, apiCommand, apiParam1);
            if (typeof response != 'undefined') { response.end("Completed processing request."); }
            return;

        case "LIGHTINGSCENES":
            scene_command (logging.operation_num, apiDevice, apiCommand);
            if (typeof response != 'undefined') { response.end("Completed processing request."); }
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
            if (typeof response != 'undefined') { response.status(404).send("ERROR: Module not valid."); }
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
        if (typeof response != 'undefined') { response.status(404).send("ERROR: Device not found."); }
        return;
    }

    // Search for the command
    let curExecute = extractCommand(curDevice, apiCommand);
    if(!curExecute) {
        console.log("%d - Command not found", debugId);
        if (typeof response != 'undefined') { response.status(404).send("ERROR: Command not found."); }
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
            } else if(apiCommand=="PLAY") {
                // Now-playing card transport: resume on whatever device is
                // active, WITHOUT re-transferring to the Echo (that's ON's job).
                spotifyResume(nextDebugId);
            } else if(apiCommand=="PAUSE") {
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
        if (typeof response != 'undefined') { response.status(404).send("ERROR: Device scene not found."); }
        return;
    }


    // Search for the audio device
    let curAudio, curAudioInput, curAudioOff;
    if(curDeviceScene.audioDevice && curDeviceScene.audioInput){

        // Search for the device
        curAudio = extractDevice(curDeviceScene.audioDevice);
        if(!curAudio) {
            console.log("%d - Audio device not found", debugId);
            if (typeof response != 'undefined') { response.status(404).send("ERROR: Audio device not found."); }
            return;
        }

        // Search for the command
        curAudioInput = extractCommand(curAudio, curDeviceScene.audioInput);
        curAudioOff = extractCommand(curAudio, "OFF");
        if(!curAudioInput || !curAudioOff) {
            console.log("%d - Audio command not found", debugId);
            if (typeof response != 'undefined') { response.status(404).send("ERROR: Audio command not found."); }
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
            if (typeof response != 'undefined') { response.status(404).send("ERROR: Video device not found."); }
            return;
        }

        // Search for the command
        curVideoOn = extractCommand(curVideo, "ON");
        curVideoOff = extractCommand(curVideo, "OFF");
        if(!curVideoOn || !curVideoOff) {
            console.log("%d - Video command not found", debugId);
            if (typeof response != 'undefined') { response.status(404).send("ERROR: Video command not found."); }
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

    // Respond with something to kill connection
    if (typeof response != 'undefined') { response.end("Completed processing request."); }
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
    let macroId;
    let passOnOff=false;
    for (const macro of macros) {
        if (macro.id && macro.id.toUpperCase() === apiDevice) {
          macro_commands = macro.commands;
          macroId = macro.id;
          passOnOff = macro.passOnOff;
        }
    }

    if(!macro_commands) {
        console.log("%d - Macro commands not found", debugId);
        if (typeof response != 'undefined') { response.status(404).send("ERROR: Macro not found."); }
        return;
    }

    // Resolve each macro entry to the concrete request path it should
    // dispatch for this on/off invocation, up front -- dispatch itself
    // happens below, spaced out over time, so the on/off resolution (which
    // depends only on apiCommand, not on timing) is done in one synchronous
    // pass here.
    const requestPaths = [];
    for (var i=0; i < macro_commands.length; i++) {
            var curCommand = macro_commands[i];

            // Object form -- { "on": "...", "off": "..." } -- lets a single
            // macro entry specify DIFFERENT command paths for on vs off,
            // instead of passOnOff's blind "/" + apiCommand append. Needed
            // whenever the on-state path already has its own trailing
            // command/param (e.g. "lights/kitchen/50" to dim to a specific
            // level) -- appending apiCommand as a further trailing segment
            // in that case is silently ignored by modules like LIGHTS
            // (which only look at the segment right after the device id),
            // so the command runs unconditionally regardless of on/off,
            // instead of toggling. See studioMacro in macros.json for a
            // real example (issue: "turning off Studio turned lights on").
            if (curCommand && typeof curCommand === 'object') {
                var objectFormPath = (apiCommand === 'OFF') ? curCommand.off : curCommand.on;
                if (objectFormPath) {
                    requestPaths.push("/"+objectFormPath);
                } else {
                    console.log("%d - Macro command has no '%s' path, skipping", debugId, apiCommand === 'OFF' ? 'off' : 'on');
                }
                continue;
            }

            // console.log("%d - Running Command: %s", debugId, curCommand);
            if(passOnOff){
                requestPaths.push("/"+curCommand+"/"+apiCommand);
            } else {
                requestPaths.push("/"+curCommand);
            }
    }

    // Dispatch sequentially, spaced MACRO_COMMAND_SPACING_MS apart, instead
    // of firing every command in the same parallel burst (live-verified bug:
    // studioMacro's ~7-command burst overflowed the Insteon hub's small
    // command buffer and silently dropped one -- kitchen/on never executed,
    // though it works fine issued alone). Fire-and-forget: must never block
    // the HTTP response below, so this is kicked off without awaiting it.
    // Each dispatched command still goes through handleRequest(), so it gets
    // its own operation_num and the usual per-command log lines.
    dispatchMacroCommandsSequentially(requestPaths);

    // Record the macro's on/off activation for the dashboard's scene/macro
    // shadow state (retained apollo/home/macro/<id>/state). Recorded
    // immediately (not deferred to match the spaced-out dispatch above) so
    // the dashboard reflects the macro's new on/off state right away, same
    // as before this change. Lazy require to avoid load-order coupling; safe
    // no-op in dry-run / broker-down.
    try { require('./sceneShadow').onMacroActivated(macroId, apiCommand); }
    catch (e) { console.log("%d - sceneShadow macro record skipped: %s", debugId, e && e.message); }

    // Respond with something to kill connection
    if (typeof response != 'undefined') { response.end("Completed processing request."); }
}

// Spacing between successive commands in a macro's dispatch sequence. Small
// enough that a macro still feels instantaneous to the user, large enough
// that the Insteon hub's small command buffer has time to drain between
// sends instead of dropping one under a rapid-fire burst.
const MACRO_COMMAND_SPACING_MS = 400;

/**
 * Fires a macro's resolved request paths one at a time via handleRequest(),
 * MACRO_COMMAND_SPACING_MS apart, instead of a parallel burst. The first
 * command fires immediately (synchronously, within this call) so a
 * single-command macro is unaffected; subsequent commands are chained via
 * setTimeout. Never throws outward -- handleRequest() already handles its
 * own errors per command -- and never returns a value; callers treat this as
 * fire-and-forget.
 * @param {string[]} requestPaths - already-resolved "/module/device/command" paths
 */
function dispatchMacroCommandsSequentially(requestPaths) {
    let index = 0;

    function runNext() {
        if (index >= requestPaths.length) {
            return;
        }
        const path = requestPaths[index++];
        handleRequest(path);

        if (index < requestPaths.length) {
            const timer = setTimeout(runNext, MACRO_COMMAND_SPACING_MS);
            if (typeof timer.unref === 'function') {
                timer.unref();
            }
        }
    }

    runNext();
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

    if(!apiCommand) {
        console.log("%d - ERROR: Command not specified", debugId);
        if (typeof response != 'undefined') { response.status(404).send("ERROR: Command not found."); }
        return;
    }

    // Search for the device
    let curDevice = extractDevice(apiDevice);
    if(!curDevice) {
        console.log("%d - Device not found", debugId);
        if (typeof response != 'undefined') { response.status(404).send("ERROR: Device not found."); }
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
        if (apiCommand == "SETVOLUME" || apiCommand == "ADJUSTVOLUME" || apiCommand == "SETMUTE") {
            console.log("%d - Speaker device command", debugId);
            alexaSpeaker(logging.operation_num, curDevice, apiCommand, apiParam1, apiParam2);
            if (typeof response != 'undefined') { response.end("Completed processing request."); }
        } else {
            console.log("%d - ERROR: Unknown command %s", debugId, apiCommand);
            if (typeof response != 'undefined') { response.status(404).send("ERROR: Command not found."); }
        }
        return;
    }

    // Process as a standard device command
    send_ip_command(logging.operation_num, curDevice, curExecute, false);
    if (typeof response != 'undefined') { response.end("Completed processing request."); }
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

    if(!apiParam1) {
        console.log("%d - ERROR: Command not specified", debugId);
        if (typeof response != 'undefined') { response.status(404).send("ERROR: Command not found."); }
        return;
    }

    // Search for the device
    let curDevice = extractDevice("door");
    if(!curDevice) {
        console.log("%d - Door device not found", debugId);
        if (typeof response != 'undefined') { response.status(404).send("ERROR: Device not found."); }
        return;
    }

    // Search for the command
    let curExecute = extractCommand(curDevice, apiCommand);
    if(!curExecute) {
        console.log("%d - Command not found", debugId);
        if (typeof response != 'undefined') { response.status(404).send("ERROR: Command not found."); }
        return;
    }

    console.log("%d - API Device ID: %s", debugId, apiDevice);
    console.log("%d - API Command: %s", debugId, apiCommand);

    console.log("%d - Device title: %s", debugId, curDevice.title);
    console.log("%d - Device type: %s", debugId, curDevice.type);
    console.log("%d - Device address: %s", debugId, curDevice.address);
    console.log("%d - Device Execute: %s\n", debugId, curExecute);

    if (apiParam1 == "UNLOCK") {
        console.log("%d - Door unlock command", debugId);
        send_cc_command(curDevice.address,curExecute,logging.operation_num);
        if (typeof response != 'undefined') { response.end("Completed processing request."); }
    } else {
        console.log("%d - ERROR: Unknown command %s", debugId, apiCommand);
        if (typeof response != 'undefined') { response.status(404).send("ERROR: Command not found."); }
    }

}

function handleAC(debugId, apiDevice, apiCommand, apiParam1, response) {

    if(!apiCommand) {
        console.log("%d - ERROR: Command not specified", debugId);
        if (typeof response != 'undefined') { response.status(404).send("ERROR: Command not found."); }
        return;
    }

    // Search for the device
    let curDevice = extractDevice(apiDevice);
    if(!curDevice) {
        console.log("%d - Device not found", debugId);
        if (typeof response != 'undefined') { response.status(404).send("ERROR: Device not found."); }
        return;
    }

    // Dashboard climate shadow routing: the AC is a one-way IR blaster, so
    // Apollo holds an assumed state and translates absolute intents into
    // relative IR (see src/climateShadow.js). setpoint/mode/fan/power drive IR
    // + update the shadow; override_* corrects the shadow WITHOUT sending IR.
    // Lazy require avoids load-order coupling; safe no-op in dry-run.
    if (curDevice.isAC || (curDevice.alexa && curDevice.alexa.isAC)) {
        const done = () => { if (typeof response != 'undefined') { response.end("Completed processing request."); } };
        const climate = (() => { try { return require('./climateShadow'); } catch (e) { return null; } })();
        if (climate) {
            switch (apiCommand) {
                case "SETPOINT": climate.setSetpoint(Number(apiParam1)); done(); return;
                case "MODE": climate.setMode(String(apiParam1).toUpperCase()); done(); return;
                case "FAN": climate.setFan(String(apiParam1).toLowerCase()); done(); return;
                case "OVERRIDE_SETPOINT": climate.override({ setpoint: Number(apiParam1) }); done(); return;
                case "OVERRIDE_MODE": climate.override({ mode: String(apiParam1).toUpperCase() }); done(); return;
                case "OVERRIDE_FAN": climate.override({ fan: String(apiParam1).toLowerCase() }); done(); return;
                case "OVERRIDE_POWER": climate.override({ power: apiParam1 === 'ON' || apiParam1 === 'TRUE' }); done(); return;
                case "ON": climate.setPower(true); done(); return;
                case "OFF": climate.setPower(false); done(); return;
                default: break; // fall through to raw IR command handling
            }
        }
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
        if (apiCommand == "ADJUSTTARGETTEMPERATURE") {
            console.log("%d - Adjust AC temperature by %s", debugId, apiParam1);
            alexaAC(logging.operation_num, curDevice, apiCommand, apiParam1);
            if (typeof response != 'undefined') { response.end("Completed processing request."); }

        } else if (apiCommand == "SETTHERMOSTATMODE") {
            console.log("%d - Change AC mode to %s", debugId, apiParam1);
            alexaAC(logging.operation_num, curDevice, apiCommand, apiParam1);
            if (typeof response != 'undefined') { response.end("Completed processing request."); }

        } else {
            console.log("%d - ERROR: Unknown command %s", debugId, apiCommand);
            if (typeof response != 'undefined') { response.status(404).send("ERROR: Command not found."); }
        }
        return;
    }

    // Process as a standard device command
    send_ir_command(curDevice.address,curExecute,logging.operation_num);
    if (typeof response != 'undefined') { response.end("Completed processing request."); }
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