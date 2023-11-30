/**
 * Apollo Home Control Bridge - Somfy Module
 * @module somfyBridge.js
 * 
 * @author Ray Perfetti
 * @date 2023-10-05
 * 
 * @description   Controls Somfy shades via a separate bridge application ESPSomfy-RTS
 *                https://github.com/rstrouse/ESPSomfy-RTS
 * 
 *                The hardware is an ESP32 with a CC1101 Transceiver costsing about $12.
 *  
 *                If you've messed around with Somfy, you know that the RTS controllers are absurdly expensive.
 *                The Universal RTS Interface II (URTSI II-16 Channel) is $400+
 * 
 *                This module just sends the command. Transmission to the shades is handled by the bridge.
 * 
 */

const http = require('http');

function send_somfy_command (address, id, command, operation_num) {

  let urlCommand;

  // See documentation @ https://github.com/rstrouse/ESPSomfy-RTS/wiki/Integrations
  switch (command) {
      case "ON":
          urlCommand = "command=down";
          break;

      case "OFF":
          urlCommand = "command=up";
          break;

      case "STOP":
          urlCommand = "command=my";
          break;

      default:
          if(!command){
            // When no command is passed, we assume ON
            urlCommand = "command=down";
          } else if(!isNaN(command)){
              // If the command is a number, it's a percentage [0-100] that the shade should move to
              urlCommand = "target=" + command;
          } else {
              console.log("%d - ERR: Command Not Recognized: %s", operation_num, command);
              return; // Exit the function if the command is not recognized
          }
  }

  const url = `http://${address}/shadeCommand?shadeId=${id}&${urlCommand}`;
  console.log("%d - URL: %s", operation_num, url);

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
    send_somfy_command
};