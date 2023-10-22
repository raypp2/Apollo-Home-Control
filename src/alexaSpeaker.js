/**
 * Apollo Home Control Bridge - Alexa Speaker Module
 * @module alexaSpeaker.js
 * 
 * @author Ray Perfetti
 * @date 2021-10-05
 * 
 * @description     Handles device commands for Alexa Smart Home Skill speakers
 *                  Volume and Mute can be adjusted
 * 
 */



/*

Alex Innvocation Syntax                         Payload Value

Alexa, turn the volume down on Anthem           -10 | true
Alexa, turn the volume up on Anthem             10 | true
Alexa, set the volume of Anthem to X            Values 0 - 100
Alexa, turn the volume down on Anthem by 20     -20 | false
Alexa, mute Anthem                              mute=true
Alexa, unmute Anthem                            mute=false

*/

const { send_ip_command }                       // IP Devices
        = require('./tcpServers');



function alexaSpeaker(debugId, curDevice, apiCommand, apiParam1, apiParam2) {

    curExecute = false;
    switch(apiCommand.toUpperCase()) {

        case 'SETVOLUME':
            console.log("%d - Setting volume to %s", debugId, apiParam1);
            curExecute = curDevice.speaker.volumeValue;
            curExecute = curExecute.replace('<VOLUME>', apiParam1);

            send_ip_command(debugId, curDevice, curExecute, false);
            break;

        case 'ADJUSTVOLUME':
            apiParam1 = parseInt(apiParam1); //Convert to integer
            if(apiParam1 > 0) {
                if(apiParam1>curDevice.speaker.volumeMaxStep){
                    console.log("%d - WARNING: Can not change by %s. Adjusting to max.", debugId, apiParam1);
                    apiParam1 = curDevice.speaker.volumeMaxStep;
                }
                curExecute = curDevice.speaker.volumeUp;
                curExecute = curExecute.replace('<VOLUME>', apiParam1);
                console.log("%d - Adjusting volume up by %s", debugId, apiParam1);
            } else {
                if(apiParam1<(curDevice.speaker.volumeMaxStep*-1)){
                    console.log("%d - WARNING: Can not change by %s. Adjusting to max.", debugId, apiParam1);
                    apiParam1 = curDevice.speaker.volumeMaxStep*-1;
                }
                curExecute = curDevice.speaker.volumeDown;
                curExecute = curExecute.replace('<VOLUME>', apiParam1 * -1);
                console.log("%d - Adjusting volume down by %s", debugId, apiParam1);
            }
            
            send_ip_command(debugId, curDevice, curExecute, false);
            break;

        case 'SETMUTE':
            if(apiParam1 == 'TRUE') {
                send_ip_command(debugId, curDevice, curDevice.speaker["muteOn"], false);
            } else {
                send_ip_command(debugId, curDevice, curDevice.speaker["muteOff"], false);
            }
            break;

        default:
            console.log("%d - ERROR: Unknown command %s", debugId, apiCommand);
    }
    
}

module.exports = {
    alexaSpeaker
}