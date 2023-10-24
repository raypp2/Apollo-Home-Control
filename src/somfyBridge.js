/**
 * Apollo Home Control Bridge - Somfy Module
 * @module somfyBridge.js
 * 
 * @author Ray Perfetti
 * @date 2023-10-05
 * 
 * @description   Controls Somfy shades via a separate bridge application that uses
 *                the ZRTSII Z-Wave to RTS Plug-in Wall Module.
 *  
 *                If you've messed around with Somfy, you know that the RTS controllers are absurdly expensive.
 *                The Universal RTS Interface II (URTSI II-16 Channel) is $400+ and they break easily.
 *                By contrast, the ZRTSII Z-Wave to RTS Plug-in Wall Module is $100 on eBay.
 *                With a cheap USB Z-Wave stick, you can control 16 shades for $130 or less.
 * 
 *                This module just sends the command. Transmission to the shades is handled by the bridge.
 *                GITHUB URL
 * 
 *                References:
 *                - https://www.somfysystems.com/en-us/products/1811265/z-wave-to-rts-plug-in-wall-module-zrtsi-16-channel
 * 
 * 
 */

// Uncomment for local testing
// var http = require('http');

function send_somfy_command (device_address, device_port, device_id, device_command,operation_num) {

  device_command = device_command.toLowerCase();
  // Default ON command. This happens via the web interface.
  if(device_command != ("off" || "stop")) {
    device_command = "on";
  }

	var bridge_command = {
	  host: device_address,
	  port: device_port,
	  method: 'POST',
	  path: '/' + device_id + '/' + device_command
	};

	var str = '';

    //console.log("%d - Sending Command: %s", operation_num, device_command);

    var req = http.request(bridge_command, function(response) {
      

      response.on('data', function (chunk) {
        str += chunk;
      });

      response.on('end', function () {
      // Add error handling for no response
        console.log("%d - %s", operation_num, str);
      });

    });

	req.on('error', function(err) {
	console.log("%d - ERROR: %s", operation_num, err);
	});

	req.end();
}

module.exports = {
    send_somfy_command
};