/**
 * Apollo Home Control Bridge - Find My iPhone Module
 * 
 * @module findMy.js
 * 
 * @author Ray Perfetti
 * @date 2021-10-05
 * 
 * @description Plays a sound on the iPhone device even when on silent.
 * 				Requires user authentication details in .env file.
 * 
 * 				Dependencies:
 * 				- find-my-iphone by Matt Kruse
 * 				https://github.com/matt-kruse/find-my-iphone
 * 
 */

// Uncomment to test locally
// require('dotenv').config();

var icloud = require("find-my-iphone").findmyphone;

icloud.apple_id = process.env.icloudUsername;
icloud.password = process.env.icloudPassword;

const DRY_RUN = process.env.APOLLO_DRY_RUN === '1';

function find_my_iphone_alert(deviceID, debug_id){

	if (DRY_RUN) {
		console.log("%d - DRY RUN, would send Find My iPhone alert to device: %s", debug_id, deviceID);
		return;
	}

	icloud.getDevices(function(error, devices) {

		// Print properties of devices
		// console.log("Devices: ", JSON.stringify(devices));
		console.log("Device ID: ", deviceID);
		if (error) {
			throw error;
		}

		icloud.alertDevice(deviceID, function(err) {
			console.log("%d - Sent iPhone Device Alert", debug_id);
		});
	});
}

module.exports = {
    find_my_iphone_alert
};


// Test Find My iPhone
// find_my_iphone_alert(process.env.icloudDeviceID, 1);