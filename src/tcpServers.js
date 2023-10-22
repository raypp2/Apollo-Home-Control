/**
 * Apollo Home Control Bridge - TCP Module
 * @module tcpServers.js
 * 
 * @author Ray Perfetti
 * @date 2023-10-05
 * 
 * @description 	Queues commands to be sent to TCP devices (over IP).
 * 
 * 					A lot of devices, these days, can be controlled via IP.
 * 					(i.e. projectors, audio receivers, etc.)
 * 					They work similar to their serial counterparts but you
 * 					just don't need a serial bridge. The commands are often identical.
 * 
 * 					In addition to sending commands, this module also:
 * 					- Checks for power status before sending commands
 * 				    - Powers on devices if needed
 * 					- Sends multiple commands delimited by ~
 * 					- Sends commands in sequence with delay
 * 
 */


/**
 * Sends a command to a device over TCP/IP and checks for power status if specified.
 * @param {Object} device_info - Information about the device to connect to.
 * @param {string} device_cmd - The command to send to the device.
 * @param {boolean} check_for_power - Whether or not to check the power status of the device.
 * @param {number} debug_id - A unique identifier for debugging purposes.
 */
function send_ip_command(debug_id, device_info, device_cmd, check_for_power){
	// TODO: Check if we can move the net module to global scope
	var net = require('net');
	var client = new net.Socket();

	var device_address = device_info.address;
	var device_port = device_info.port;

	// Confirm all variables for power check
	if(check_for_power){

		if (!device_info.power_commands) { device_info.power_commands = { }; }
		var power_query = device_info.power_commands["power_query"] 			|| undefined;
		var power_query_on = device_info.power_commands["power_response_on"] 	|| undefined;
		var power_query_off = device_info.power_commands["power_response_off"] 	|| undefined;
		var on_delay = device_info.power_commands["power_on_delay"] 			|| 1; // time to wait for sending commands after powered on
		// Devices, such as PJLink Projectors, can respond with ERR3 - Busy state if query and command are sent too quickly
		var off_delay = device_info.power_commands["power_off_delay"] 			|| 0; // time to wait for sending OFF command after query
		var device_on = device_info.commands["on"]								|| undefined;
		var device_off = device_info.commands["off"]							|| undefined;

		if (typeof power_query === 'undefined') { 		check_for_power=false }
		if (typeof power_query_on === 'undefined') { 	check_for_power=false }
		if (typeof power_query_off === 'undefined') { 	check_for_power=false }
//		if (typeof on_delay === 'undefined') { 			check_for_power=false }
		if (typeof device_on === 'undefined') { 		check_for_power=false }

		if (check_for_power===false ){
			console.log("%d - ERROR: Power check variables not properly set. Skipping check.", debug_id);
		}
	}

	client.connect(device_port, device_address, function() {
		console.log("%d - Connected to IP device @ %s %s", debug_id, device_address, device_port);

		if(check_for_power){
			console.log("%d - Checking power status:", debug_id, power_query);
			client.write(power_query);
		} else {
			send_all_ip_commands();
		}

	});

	client.on('data', function(data) {
		console.log("%d - Received: %s", debug_id, data);
		if(check_for_power){
			switch(data.toString()) {
				case power_query_off:
					console.log("%d - Device is off", debug_id);
					if(device_cmd=="OFF") {
						console.log("%d - Disregarding 'off' command", debug_id);
						break; // If the command is to turn the device off that's already off
					} else {
						client.write(device_on); // Otherwise, turn it on
					}
					check_for_power=false; // function only runs once per session
					setTimeout(function(){send_all_ip_commands()},on_delay);
					break;
				case power_query_on:
					console.log("%d - Device is on", debug_id);
					if(device_cmd=="ON") {
						console.log("%d - Disregarding 'on' command", debug_id);
						break; // If the command is to turn the device on that's already on
					} else {
						setTimeout(function(){send_all_ip_commands()},off_delay);
					}
					check_for_power=false; // function only runs once per session
					break;
				default:
					console.log("%d - Response to power query not valid", debug_id);
					// Aborting for safety. This could mean there was an error or that the device is in a state not safe to power on like in lamp cooldown.
					//send_all_ip_commands();
			}
		}
	});

	client.on('error', function(err) {
    	console.log("%d - ERROR: %s", debug_id, err);
	});

	client.on('close', function() {
		console.log("%d - Connection closed", debug_id);
	});

	// Sends a ~ delimeter commands
	function send_all_ip_commands () {
		device_cmd = device_cmd.split("~");	 // Split multiple commands into array
		for (var i=0; i < device_cmd.length; i++) {
			(function (j) {
				setTimeout(function (){		// Delay send to allow for connection traffic
					console.log("%d - Sent command: %s", debug_id, device_cmd[j]);
					client.write(device_cmd[j]);
					if (j==device_cmd.length-1) {
						setTimeout(function(){client.destroy()}, 1000); // kill client after delay
					}
				}, 500*(j+1));
			}) (i)
		}
	}

};


module.exports = {
    send_ip_command
};