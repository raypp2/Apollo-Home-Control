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
 * @description (Stage 5, issue #13) send_ip_command keeps its exact signature
 *              and power-check state machine semantics, but now sends through
 *              a shared, persistent src/deviceConnection.js connection per
 *              device (host:port) instead of opening a new socket per call.
 *              Power-query responses (PJLink `%1POWR=1/0`, Anthem-style
 *              `Z1POW1;/Z1POW0;`) are parsed against the device's configured
 *              power_response_on/off strings and published via
 *              mqttTopics.publishState(). A periodic poller
 *              (startIpPowerPoller) republishes that same power state every
 *              60s for devices that have a power_query configured, so the
 *              dashboard has real state even between commands.
 *
 *              Rollback: set ITACH_PERSISTENT_CONNECTIONS=false to route back
 *              to the original per-command implementation, kept verbatim
 *              below as _legacy_send_ip_command.
 */

const { getConnection } = require('./deviceConnection');
const mqttTopics = require('./mqttTopics');

const DRY_RUN = process.env.APOLLO_DRY_RUN === '1';

const POWER_POLL_INTERVAL_MS = 60000; // how often each device's power state is re-polled
const POWER_POLL_STAGGER_MS = 5000;   // spread each device's poll start so they don't all fire at once

// Devices with a command currently in flight (address:port -> true), so the
// periodic poller can skip a cycle rather than race a real command's own
// power-check state machine.
const inFlight = new Map();

/**
 * Read live (not cached at module load) so tests can flip
 * ITACH_PERSISTENT_CONNECTIONS per-test without reloading the module.
 * @returns {boolean}
 */
function persistentConnectionsEnabled() {
	return process.env.ITACH_PERSISTENT_CONNECTIONS !== 'false';
}

function inFlightKey(device_info) {
	return `${device_info.address}:${device_info.port}`;
}

function markInFlight(device_info) {
	inFlight.set(inFlightKey(device_info), true);
}

function clearInFlight(device_info) {
	inFlight.delete(inFlightKey(device_info));
}

function isInFlight(device_info) {
	return inFlight.get(inFlightKey(device_info)) === true;
}

/**
 * Matches a (already `\r`-framing-stripped) power-query response against a
 * device's configured power_response_on/off strings. Config values are also
 * stripped of a trailing `\r` before comparing (some configs, like the PJLink
 * projector, embed a literal `\r` terminator in the expected string; others,
 * like the Anthem's `;`-terminated strings, do not) so both shapes match the
 * connection's `\r`-framed response consistently.
 * @param {object} device_info - a devices.json entry with power_commands
 * @param {string|null} response
 * @returns {"ON"|"OFF"|null}
 */
function parsePowerResponse(device_info, response) {
	if (response === null || typeof response === 'undefined') {
		return null;
	}
	const powerCommands = device_info.power_commands || {};
	const onValue = String(powerCommands.power_response_on || '').replace(/\r$/, '');
	const offValue = String(powerCommands.power_response_off || '').replace(/\r$/, '');
	const normalized = String(response).replace(/\r$/, '');

	if (onValue && normalized === onValue) {
		return 'ON';
	}
	if (offValue && normalized === offValue) {
		return 'OFF';
	}
	return null;
}

/**
 * Registered once per DeviceConnection instance, closing directly over the
 * device_info that first triggered this connection (no reverse index.js
 * lookup needed -- unlike iTach, a connection here is always opened on behalf
 * of one specific config entry, since ip_control ports are per-device rather
 * than shared). ip_control devices already have a real state schema (unlike
 * iTach's momentary/write-only devices), so connection loss just marks the
 * existing cached state unreachable via mqttTopics -- there's no separate raw
 * status topic. Coming back online is a no-op here; the next command's
 * power-check or the periodic poller refreshes real state on its own.
 * @param {import('./deviceConnection').DeviceConnection} conn
 * @param {object} device_info
 */
function registerStatusPublisher(conn, device_info) {
	if (conn._ipStatusRegistered) {
		return;
	}
	conn._ipStatusRegistered = true;

	conn.onStatusChange((status) => {
		if (status !== 'offline') {
			return;
		}
		mqttTopics.publishUnreachable(device_info);
	});
}

/**
 * Sends each `~`-delimited piece of `device_cmd` in order through the shared
 * connection, spaced automatically by DeviceConnection (replaces the old
 * 500ms*n setTimeout chain).
 * @param {import('./deviceConnection').DeviceConnection} conn
 * @param {number} debug_id
 * @param {string} device_cmd
 */
async function sendAllIpCommands(conn, debug_id, device_cmd) {
	const parts = device_cmd.split('~');
	// Enqueue every part in the SAME synchronous pass (no await between
	// conn.send() calls) so DeviceConnection sees them as a batch already
	// queued together and applies its own inter-command spacing between them
	// -- awaiting each send() one at a time before queuing the next would
	// mean there's never more than one item in the queue simultaneously, so
	// the spacing logic (which only pauses between items already queued)
	// would never actually engage, and consecutive writes could get
	// coalesced by TCP into a single packet.
	const sends = parts.map((part) => {
		console.log('%d - Sent command: %s', debug_id, part);
		return conn.send(part, { expectResponse: false });
	});
	await Promise.all(sends);
}

/**
 * Sends a command to a device over TCP/IP and checks for power status if specified.
 * @param {number} debug_id - A unique identifier for debugging purposes.
 * @param {Object} device_info - Information about the device to connect to.
 * @param {string} device_cmd - The command to send to the device.
 * @param {boolean} check_for_power - Whether or not to check the power status of the device.
 */
async function send_ip_command(debug_id, device_info, device_cmd, check_for_power){

	if (DRY_RUN) {
		console.log("%d - DRY RUN, would send IP command: %s to %s:%s", debug_id, device_cmd, device_info.address, device_info.port);
		return;
	}

	if (!persistentConnectionsEnabled()) {
		return _legacy_send_ip_command(debug_id, device_info, device_cmd, check_for_power);
	}

	markInFlight(device_info);
	try {
		const conn = getConnection(device_info.address, device_info.port, {
			name: `${device_info.address}:${device_info.port}`,
		});
		registerStatusPublisher(conn, device_info);

		let checkForPower = check_for_power;
		let power_query, power_on_delay, off_delay, device_on;

		if (checkForPower) {
			if (!device_info.power_commands) { device_info.power_commands = {}; }
			power_query = device_info.power_commands["power_query"] || undefined;
			const power_query_on = device_info.power_commands["power_response_on"] || undefined;
			const power_query_off = device_info.power_commands["power_response_off"] || undefined;
			power_on_delay = device_info.power_commands["power_on_delay"] || 1;
			off_delay = device_info.power_commands["power_off_delay"] || 0;
			device_on = device_info.commands ? device_info.commands["on"] : undefined;

			if (typeof power_query === 'undefined') { checkForPower = false; }
			if (typeof power_query_on === 'undefined') { checkForPower = false; }
			if (typeof power_query_off === 'undefined') { checkForPower = false; }
			if (typeof device_on === 'undefined') { checkForPower = false; }

			if (checkForPower === false) {
				console.log("%d - ERROR: Power check variables not properly set. Skipping check.", debug_id);
			}
		}

		if (checkForPower) {
			console.log("%d - Checking power status:", debug_id, power_query);
			const response = await conn.send(power_query, { expectResponse: true });
			console.log("%d - Received: %s", debug_id, response);

			const powerState = parsePowerResponse(device_info, response);

			// Tracks the RESULTING power state after whatever we do below (which
			// may differ from the just-queried `powerState`, e.g. we turn the
			// device on) -- this is what gets published, an optimistic update in
			// the same spirit as lightingShelly.js's shelly_command(), rather
			// than the pre-action snapshot.
			let resultingPowerState = null;

			if (powerState === 'OFF') {
				console.log("%d - Device is off", debug_id);
				resultingPowerState = 'OFF';
				if (device_cmd === "OFF") {
					console.log("%d - Disregarding 'off' command", debug_id);
				} else {
					await conn.send(device_on, { expectResponse: false });
					resultingPowerState = 'ON';
					await wait(power_on_delay);
					await sendAllIpCommands(conn, debug_id, device_cmd);
				}
			} else if (powerState === 'ON') {
				console.log("%d - Device is on", debug_id);
				resultingPowerState = 'ON';
				if (device_cmd === "ON") {
					console.log("%d - Disregarding 'on' command", debug_id);
				} else {
					await wait(off_delay);
					await sendAllIpCommands(conn, debug_id, device_cmd);
				}
			} else {
				console.log("%d - Response to power query not valid", debug_id);
				// Aborting for safety. This could mean there was an error or that the device is in a state not safe to power on like in lamp cooldown.
			}

			if (resultingPowerState) {
				mqttTopics.publishState(device_info, { power: resultingPowerState }, 'command');
			}
		} else {
			await sendAllIpCommands(conn, debug_id, device_cmd);
		}
	} finally {
		clearInFlight(device_info);
	}
};

function wait(ms) {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		timer.unref();
	});
}

/**
 * Polls a single device's power state (if it has power_commands.power_query
 * configured) and publishes it with source:'poll'. Skips silently if a real
 * command is currently in flight for this device, or if it's missing the
 * config needed to query power.
 * @param {object} device
 */
async function pollDevicePower(device) {
	if (DRY_RUN || !persistentConnectionsEnabled()) {
		return;
	}
	if (isInFlight(device)) {
		return;
	}
	if (!device.address || !device.port || !device.power_commands || !device.power_commands.power_query) {
		return;
	}

	try {
		const conn = getConnection(device.address, device.port, { name: `${device.address}:${device.port}` });
		registerStatusPublisher(conn, device);
		const response = await conn.send(device.power_commands.power_query, { expectResponse: true });
		const powerState = parsePowerResponse(device, response);
		if (powerState) {
			mqttTopics.publishState(device, { power: powerState }, 'poll');
		}
	} catch (err) {
		console.log('IP power poll for %s failed: %s', device.id || device.address, err.message);
	}
}

/**
 * Starts a 60s power-state poll for every ip_control device that has
 * power_commands.power_query configured, staggering each device's start time
 * so they don't all hit the network at once. Timers are unref'd (never keep
 * the process alive on their own) and skipped entirely in dry-run or when the
 * persistent-connections rollback flag is set (the legacy per-command path
 * has no long-lived connection to poll through, and re-opening a fresh socket
 * every 60s just to check power defeats the point of this stage).
 */
function startIpPowerPoller() {
	if (DRY_RUN || !persistentConnectionsEnabled()) {
		return;
	}

	const index = require('../index');
	const devices = index.devices || [];
	const pollable = devices.filter((d) => d.type === 'ip_control' && d.power_commands && d.power_commands.power_query);

	pollable.forEach((device, i) => {
		const startDelay = i * POWER_POLL_STAGGER_MS;
		const kickoff = setTimeout(() => {
			pollDevicePower(device);
			const interval = setInterval(() => pollDevicePower(device), POWER_POLL_INTERVAL_MS);
			interval.unref();
		}, startDelay);
		kickoff.unref();
	});
}

/**
 * Sends a command to a device over TCP/IP and checks for power status if specified.
 * (Legacy pre-Stage-5 implementation, kept verbatim. Reachable when
 * ITACH_PERSISTENT_CONNECTIONS=false.)
 * @param {Object} device_info - Information about the device to connect to.
 * @param {string} device_cmd - The command to send to the device.
 * @param {boolean} check_for_power - Whether or not to check the power status of the device.
 * @param {number} debug_id - A unique identifier for debugging purposes.
 */
function _legacy_send_ip_command(debug_id, device_info, device_cmd, check_for_power){

	if (DRY_RUN) {
		console.log("%d - DRY RUN, would send IP command: %s to %s:%s", debug_id, device_cmd, device_info.address, device_info.port);
		return;
	}

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
    send_ip_command,
    startIpPowerPoller,
    // Exported for tests only.
    parsePowerResponse,
    _legacy_send_ip_command,
    _persistentConnectionsEnabled: persistentConnectionsEnabled,
};
