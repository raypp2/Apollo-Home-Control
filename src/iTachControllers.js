/**
 * Apollo Home Control Bridge - iTach Module
 * @module iTachControllers.js
 * 
 * @author Ray Perfetti
 * @date 2023-10-05
 * 
 * @description 	Trigger Global Cache iTach controllers for serial, IR, and contact closure.
 * 				
 * 					These are simple devices; local, simple, reliable, and fast.
 * 					Turn any device into a network device.
 * 					Available cheap on eBay ($30-60)
 * 					Some models are available with PoE.
 * 					I've run these devices for years, continuously, without issue.
 * 					Including projectors, air conditioners, audio receivers, etc.
 * 
 * 					Compability:
 * 					- Global Cache IP2SL - Serial
 * 					- Global Cache IP2CC - Contact Closure
 * 					- Global Cache IP2IR - Infrared
 * 					- Global Cache Flex
 * 
 * 					References:
 * 					- https://www.globalcache.com/products.html
 */

	

/**
 * Sends a serial command to an iTach device.
 * Valid with iTach IP2SL and Flex controllers
 * @param {string} iTach_address - The IP address of the iTach device.
 * @param {string} serial_cmd - The serial command to send.
 * @param {number} debug_id - The ID for debugging purposes.
 */
function send_serial_command(iTach_address, serial_cmd, debug_id){
	// TODO: Check if we can move the net module to global scope
	var net = require('net');

	serial_cmd = serial_cmd.split("~");	 // Split multiple commands into array

	var client = new net.Socket();
	client.connect(4999, iTach_address, function() {
		console.log("%d - Connected to iTach @ %s", debug_id, iTach_address);

		for (var i=0; i < serial_cmd.length; i++) {
			(function (j) {
				setTimeout(function (){		// Delay send to allow for connection traffic
					console.log("%d - Sent command: %s", debug_id, serial_cmd[j]);
					client.write(serial_cmd[j]);
					if (j==serial_cmd.length-1) {
						setTimeout(function(){client.destroy()}, 1000); // kill client after delay
					}
				}, 1000*(j+1));
			}) (i)
		}

		

	});

	client.on('data', function(data) {
		console.log("%d - Received: %s", debug_id, data);
	});

	client.on('error', function(err) {
    	console.log("%d - ERROR: %s", debug_id, err);
	});

	client.on('close', function() {
		console.log("%d - Connection closed", debug_id);
	});
};



/**
 * Sends a command to an iTach contact closure device
 * Valid with iTach IP2CC controllers
 * @param {string} iTach_address - The IP address of the iTach device.
 * @param {string} serial_cmd - The command to send to the iTach device.
 * @param {number} debug_id - A unique identifier for debugging purposes.
 */
function send_cc_command(iTach_address, serial_cmd, debug_id){
	// TODO: Check if we can move the net module to global scope
	var net = require('net');

	serial_cmd = serial_cmd.split("~");	 // Split multiple commands into array

	var client = new net.Socket();
	client.connect(4998, iTach_address, function() {
		console.log("%d - Connected to iTach @ %s", debug_id, iTach_address);

		for (var i=0; i < serial_cmd.length; i++) {
			(function (j) {
				setTimeout(function (){		// Delay send to allow for connection traffic
					console.log("%d - Sent command: %s", debug_id, serial_cmd[j]);
					client.write(serial_cmd[j] + "\r\n"); //append carriage return
					if (j==serial_cmd.length-1) {
						setTimeout(function(){client.destroy()}, 1000); // kill client after delay
					}
				}, 1000*(j+1));
			}) (i)
		}

		

	});

	client.on('data', function(data) {
		console.log("%d - Received: %s", debug_id, data);
	});

	client.on('error', function(err) {
    	console.log("%d - ERROR: %s", debug_id, err);
	});

	client.on('close', function() {
		console.log("%d - Connection closed", debug_id);
	});
};



/**
 * Sends a command to an iTach IR device
 * Valid with iTach and iTach flex controllers
 * Also valid for iTach Contact Closures
 * @param {string} iTach_address - The IP address of the iTach device.
 * @param {string} serial_cmd - The command to send to the iTach device.
 * @param {number} debug_id - The ID used for debugging purposes.
 */
function send_ir_command(iTach_address, serial_cmd, debug_id){
	// TODO: Check if we can move the net module to global scope
	var net = require('net');

	serial_cmd = serial_cmd.split("~");	 // Split multiple commands into array

	var client = new net.Socket();
	client.connect(4998, iTach_address, function() {
		console.log("%d - Connected to iTach @ %s", debug_id, iTach_address);

		for (var i=0; i < serial_cmd.length; i++) {
			(function (j) {
				setTimeout(function (){		// Delay send to allow for connection traffic
					console.log("%d - Sent command: %s", debug_id, serial_cmd[j]);
					client.write(serial_cmd[j] + "\r\n"); //append carriage return
					if (j==serial_cmd.length-1) {
						setTimeout(function(){client.destroy()}, 1000); // kill client after delay
					}
				}, 1000*(j+1));
			}) (i)
		}

		

	});

	client.on('data', function(data) {
		console.log("%d - Received: %s", debug_id, data);
	});

	client.on('error', function(err) {
    	console.log("%d - ERROR: %s", debug_id, err);
	});

	client.on('close', function() {
		console.log("%d - Connection closed", debug_id);
	});
};

module.exports = {
	send_serial_command,
	send_cc_command,
	send_ir_command
};