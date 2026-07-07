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
 *
 * @description (Stage 5, issue #13) The three send functions below are now
 *              thin wrappers over a shared, persistent src/deviceConnection.js
 *              connection per iTach box (host:port) instead of opening a new
 *              `net.Socket` for every command -- iTach controllers only accept
 *              ONE TCP client per port, so the old per-command sockets could
 *              race each other. Each wrapper also registers a status
 *              publisher (apollo/<location>/itach/<mqttName>/status) the first
 *              time it sees a given host:port, via a reverse lookup into
 *              devices.json by address.
 *
 *              Rollback: set ITACH_PERSISTENT_CONNECTIONS=false to route back
 *              to the original per-command implementation, kept verbatim
 *              below as the _legacy_* functions.
 */

var net = require('net');
const { getConnection } = require('./deviceConnection');
const mqttClient = require('./mqttClient');
const mqttTopics = require('./mqttTopics');

const DRY_RUN = process.env.APOLLO_DRY_RUN === '1';

const SERIAL_PORT = 4999;
const IR_CC_PORT = 4998;

/**
 * Read live (not cached at module load) so tests can flip
 * ITACH_PERSISTENT_CONNECTIONS per-test without reloading the module.
 * @returns {boolean}
 */
function persistentConnectionsEnabled() {
	return process.env.ITACH_PERSISTENT_CONNECTIONS !== 'false';
}

// Lazily-populated reference to devices.json, used only by the status
// publisher's reverse address lookup below. Populated from require('../index')
// the FIRST time a connection status actually changes (not at module load --
// merely requiring this file must not boot index.js, same rule as every
// other src/ module). Overridable via _init(), same escape hatch
// mqttTopics.js documents and uses, so tests can exercise the status
// publisher without booting the real config/webServer/SQS/etc.
let devicesRef;
let devicesInitialized = false;

function ensureDevicesInit() {
	if (devicesInitialized) {
		return;
	}
	const index = require('../index');
	devicesRef = index.devices;
	devicesInitialized = true;
}

/**
 * Test-only override hook, mirroring mqttTopics.js's _init(). Production code
 * never calls this -- it gets the real devices.json via the lazy
 * require('../index') in ensureDevicesInit().
 * @param {{devices: Array<object>}} deps
 */
function _init({ devices }) {
	devicesRef = devices;
	devicesInitialized = true;
}

/**
 * Maps a devices.json `type` to the fixed TCP port its persistent connection
 * lives on, so the reverse address lookup below only matches entries that
 * actually share this physical connection.
 * @param {string} type
 * @returns {number|null}
 */
function portForType(type) {
	if (type === 'iTach_serial') return SERIAL_PORT;
	if (type === 'iTach_ir' || type === 'iTach_CC') return IR_CC_PORT;
	return null;
}

/**
 * Pure reverse lookup: which devices.json entries live on this host:port
 * connection (an iTach box can host more than one logical device -- e.g. a
 * Flex unit doing both IR and CC through the same port). Exported standalone
 * (no require('../index') inside it) so it's directly unit-testable against a
 * fixture devices array, same spirit as mqttTopics.js's testing approach.
 * @param {Array<object>} devices
 * @param {string} host
 * @param {number} port
 * @returns {Array<object>}
 */
function matchingDevicesForAddress(devices, host, port) {
	return (devices || []).filter((d) => d.address === host && portForType(d.type) === port);
}

/**
 * Registers (once per DeviceConnection instance) a status listener that
 * republishes 'online'/'offline' to apollo/<location>/itach/<mqttName>/status
 * for every devices.json entry sharing this host:port. iTach devices (IR/CC/
 * serial) have no meaningful "state" schema of their own -- unlike lights,
 * they're momentary/write-only -- so this dedicated status topic (rather than
 * mqttTopics.publishState) is the only reachability signal available for them.
 * @param {import('./deviceConnection').DeviceConnection} conn
 * @param {string} host
 * @param {number} port
 */
function registerStatusPublisher(conn, host, port) {
	if (conn._itachStatusRegistered) {
		return;
	}
	conn._itachStatusRegistered = true;

	conn.onStatusChange((status) => {
		ensureDevicesInit();
		const matches = matchingDevicesForAddress(devicesRef, host, port);
		for (const entry of matches) {
			const topic = mqttTopics.topicFor(entry, 'status');
			mqttClient.publish(topic, status, { qos: 1, retain: true });
		}
	});
}

/**
 * Sends each `~`-delimited piece of `cmd` in order through the shared
 * connection, logging in the same format as the old per-command code. When
 * expectResponse is true, logs any framed response (e.g. iTach's
 * "completeir,..."/"getstate,..." delivery confirmations) but never blocks
 * the command on it being well-formed.
 * @param {import('./deviceConnection').DeviceConnection} conn
 * @param {number} debug_id
 * @param {string} cmd
 * @param {{suffix?: string, expectResponse?: boolean}} [opts]
 */
async function sendFramed(conn, debug_id, cmd, { suffix = '', expectResponse = false } = {}) {
	const parts = cmd.split('~'); // Split multiple commands into array
	// Enqueue every part in the SAME synchronous pass (no await between
	// conn.send() calls) so DeviceConnection sees them as a batch already
	// queued together and applies its own inter-command spacing between them
	// -- awaiting each send() one at a time before queuing the next would
	// mean there's never more than one item in the queue simultaneously, so
	// the spacing logic (which only pauses between items already queued)
	// would never actually engage, and consecutive writes could get
	// coalesced by TCP into a single packet.
	const sends = parts.map(async (part) => {
		console.log('%d - Sent command: %s', debug_id, part);
		const response = await conn.send(part + suffix, { expectResponse });
		if (response) {
			console.log('%d - Received: %s', debug_id, response);
		}
	});
	await Promise.all(sends);
}

/**
 * Sends a serial command to an iTach device.
 * Valid with iTach IP2SL and Flex controllers
 * @param {string} iTach_address - The IP address of the iTach device.
 * @param {string} serial_cmd - The serial command to send.
 * @param {number} debug_id - The ID for debugging purposes.
 */
function send_serial_command(iTach_address, serial_cmd, debug_id){

	if (DRY_RUN) {
		console.log("%d - DRY RUN, would send serial command: %s to %s", debug_id, serial_cmd, iTach_address);
		return;
	}

	if (!persistentConnectionsEnabled()) {
		return _legacy_send_serial_command(iTach_address, serial_cmd, debug_id);
	}

	// spacingMs 1000 preserves the legacy iTach chains' 1000ms inter-command
	// gap (1000*(j+1) setTimeouts) -- IR/serial hardware timing was tuned to it.
	const conn = getConnection(iTach_address, SERIAL_PORT, { name: `${iTach_address}:${SERIAL_PORT}`, spacingMs: 1000 });
	registerStatusPublisher(conn, iTach_address, SERIAL_PORT);

	// Raw write, no CRLF, no response expected -- matches the legacy serial
	// behavior (it only logged whatever arrived, never gated on it).
	return sendFramed(conn, debug_id, serial_cmd, { suffix: '', expectResponse: false });
}



/**
 * Sends a command to an iTach contact closure device
 * Valid with iTach IP2CC controllers
 * @param {string} iTach_address - The IP address of the iTach device.
 * @param {string} serial_cmd - The command to send to the iTach device.
 * @param {number} debug_id - A unique identifier for debugging purposes.
 */
function send_cc_command(iTach_address, serial_cmd, debug_id){

	if (DRY_RUN) {
		console.log("%d - DRY RUN, would send contact closure command: %s to %s", debug_id, serial_cmd, iTach_address);
		return;
	}

	if (!persistentConnectionsEnabled()) {
		return _legacy_send_cc_command(iTach_address, serial_cmd, debug_id);
	}

	const conn = getConnection(iTach_address, IR_CC_PORT, { name: `${iTach_address}:${IR_CC_PORT}`, spacingMs: 1000 });
	registerStatusPublisher(conn, iTach_address, IR_CC_PORT);

	return sendFramed(conn, debug_id, serial_cmd, { suffix: '\r\n', expectResponse: true });
}



/**
 * Sends a command to an iTach IR device
 * Valid with iTach and iTach flex controllers
 * Also valid for iTach Contact Closures
 * @param {string} iTach_address - The IP address of the iTach device.
 * @param {string} serial_cmd - The command to send to the iTach device.
 * @param {number} debug_id - The ID used for debugging purposes.
 */
function send_ir_command(iTach_address, serial_cmd, debug_id){

	if (DRY_RUN) {
		console.log("%d - DRY RUN, would send IR command: %s to %s", debug_id, serial_cmd, iTach_address);
		return;
	}

	if (!persistentConnectionsEnabled()) {
		return _legacy_send_ir_command(iTach_address, serial_cmd, debug_id);
	}

	const conn = getConnection(iTach_address, IR_CC_PORT, { name: `${iTach_address}:${IR_CC_PORT}`, spacingMs: 1000 });
	registerStatusPublisher(conn, iTach_address, IR_CC_PORT);

	return sendFramed(conn, debug_id, serial_cmd, { suffix: '\r\n', expectResponse: true });
}


// ---------------------------------------------------------------------------
// Legacy (pre-Stage-5) implementations, kept verbatim. Reachable when
// ITACH_PERSISTENT_CONNECTIONS=false. See module doc comment above.
// ---------------------------------------------------------------------------

function _legacy_send_serial_command(iTach_address, serial_cmd, debug_id){

	if (DRY_RUN) {
		console.log("%d - DRY RUN, would send serial command: %s to %s", debug_id, serial_cmd, iTach_address);
		return;
	}

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
function _legacy_send_cc_command(iTach_address, serial_cmd, debug_id){

	if (DRY_RUN) {
		console.log("%d - DRY RUN, would send contact closure command: %s to %s", debug_id, serial_cmd, iTach_address);
		return;
	}

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
function _legacy_send_ir_command(iTach_address, serial_cmd, debug_id){

	if (DRY_RUN) {
		console.log("%d - DRY RUN, would send IR command: %s to %s", debug_id, serial_cmd, iTach_address);
		return;
	}

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
	send_ir_command,
	// Exported for tests only (legacy-flag routing, direct verbatim-behavior checks,
	// and the pure address->config-entry matching used by the status publisher).
	_legacy_send_serial_command,
	_legacy_send_cc_command,
	_legacy_send_ir_command,
	_persistentConnectionsEnabled: persistentConnectionsEnabled,
	_matchingDevicesForAddress: matchingDevicesForAddress,
	_portForType: portForType,
	_init,
};
