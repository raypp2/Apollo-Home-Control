/**
 * Apollo Home Control Bridge - Shelly Module
 * @module lightingShelly.js
 * 
 * @author Ray Perfetti
 * @date 2023-11-14
 * 
 * @description  Controls shelly devices
*                with the ability to turn on/off.
*  
*/

const http = require('http');

function shelly_command(operation_num, address, command) {
    let urlCommand;

    switch (command) {
        case "ON":
            urlCommand = "on";
            break;

        case "OFF":
            urlCommand = "off";
            break;

        default:
            console.log("%d - ERR: Command Not Recognized: %s", operation_num, command);
            return; // Exit the function if the command is not recognized
    }

    const url = `http://${address}/relay/0?turn=${urlCommand}`;

    http.get(url, (resp) => {
        let data = '';

        resp.on('data', (chunk) => {
            data += chunk;
        });

        resp.on('end', () => {
            console.log("%d - Response: %s", operation_num, data);
        });

    }).on("error", (err) => {
        console.log("%d - Error: %s", operation_num, err.message);
    });

    console.log("%d - Sent Command: %s", operation_num, command);
}

module.exports = {
    shelly_command
  };
