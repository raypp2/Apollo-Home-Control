/**
 * Apollo Home Control Bridge - Spotify Module
 * @module spotify.js
 * 
 * @author Ray Perfetti
 * @date 2023-11-14
 * 
 * @description 	Plays Spotify on a Spotify Connect device
 * 					This is done by transfering playback to the device
 * 					and starting playback if not already playing.
 * 
 * 					Where playback is ongoing, the song continues from same timecode.
 * 					This allows for a seamless transition between devices.
 * 					So you're playing your phone in the car, you get home, and you want to continue
 * 					Say "Alexa, turn on Ray's music" and the song continues on your home stereo.
 * 
 * 					Use spotiftyHelper.js to setup.
 * 
 * 				  	Dependencies:
 * 					- Spotify Web API Node by Michael Thelin
 * 						https://github.com/thelinmichael/spotify-web-api-node
 * 					- Spotify Premium Account
 * 
 * 					References:
 * 					- https://github.com/thelinmichael/spotify-web-api-node
 * 					- https://developer.spotify.com/web-api/transfer-a-users-playback/
 * 
 */

// Uncomment to test locally
// require('dotenv').config();

var SpotifyWebApi = require('spotify-web-api-node');
var spotifyApi = new SpotifyWebApi({
    clientId: process.env.spotifyClientId,
    clientSecret: process.env.spotifyClientSecret,
    redirectUri: process.env.spotifyRedirectUri
});

function spotifySwitchPlay(deviceName, context_uri, debug_id) {

	// ** Never uncomment these lines unless for debugging. They write sensitive data to the console.
    // console.log("%d - Credentials", debug_id, `Client ID: ${process.env.spotifyClientId}`);
	// console.log("%d - Credentials", debug_id, `Client Secret: ${process.env.spotifyClientSecret}`);
	// console.log("%d - Credentials", debug_id, `Redirect URI: ${process.env.spotifyRedirectUri}`);
	// console.log("%d - Credentials", debug_id, `Refresh Token: ${process.env.spotifyRefreshToken}`);

    var transfer_attempts_delay = [5000, 5000, 5000];

    spotifyApi.setAccessToken(process.env.spotifyRefreshToken);
    spotifyApi.setCredentials({
        'refreshToken': process.env.spotifyRefreshToken
    });

    spotifyApi.refreshAccessToken()
        .then(function(data) {
            // Save the access token so that it's used in future calls
            spotifyApi.setAccessToken(data.body['access_token']);
            console.log("%d - Refreshed Spotify Auth Token", debug_id);
        })
        .then(function() {
            return spotifyApi.getMyDevices();
        })
        .then(function(devicesData) {
            var foundDevice = devicesData.body.devices.find(device => device.name === deviceName);

            if (!foundDevice) {
                console.log("%d - Device not found: %s", debug_id, deviceName);
                return;
            }

            return spotifyApi.getMyCurrentPlaybackState()
                .then(function(playbackData) {

                    // This console log will fail if there is no playback device active
                    // console.log("%d - Current playback is on device: %s", debug_id, data.body.device.name);
                    // console.log("%d - Playback status is: %s", debug_id, data.body.is_playing);

                    // Runs immediately then re-runs if failed for each value in the transfer_attemps_delay array

                    var deviceToSwitch = foundDevice.id;

                    function transferPlayback(num) {
                        spotifyApi.transferMyPlayback([deviceToSwitch], {"play": false})
                            .then(function() {
                                console.log("%d - Transferred playback to: %s", debug_id, deviceName);

                                if (context_uri) {
                                    // Play a specific URI (album, artist, playlist) if provided
                                    spotifyApi.play({
                                        "device_id": deviceToSwitch,
                                        "context_uri": context_uri
                                    }).then(function() {
                                        console.log("%d - Started playback of context: %s on device: %s", debug_id, context_uri, deviceName);
                                    }).catch(function(err) {
                                        console.log('%d - Error starting playback of context on new device:', debug_id, err);
                                    });
                                }else {
                                    // If music was playing, resume it on the new device
                                    spotifyApi.play({
                                        "device_id": deviceToSwitch
                                    }).then(function() {
                                        console.log("%d - Resumed playback on new device: %s", debug_id, deviceName);
                                    }).catch(function(err) {
                                        console.log('%d - Error resuming playback on new device:', debug_id, err);
                                    });
                                }
                                // If no context_uri is provided and music was playing, it will continue playing on the new device without restarting
                            }, function(err) {
                                handleTransferError(err, num);
                            });
                    }

                    function handleTransferError(err, num) {
                        if (num < transfer_attempts_delay.length && err.statusCode == "404") {
                            var attempt_delay = transfer_attempts_delay[num];
                            console.log('%d - Spotify device not yet active', debug_id);
                            console.log('%d - Making attempt %s after a %s second delay.', debug_id, num + 2, (attempt_delay / 1000));
                            setTimeout(() => transferAttempt(num + 1), attempt_delay);
                        } else {
                            console.log('%d - Spotify API ERROR:', debug_id, err);
                        }
                    }

                    // Kickoff first run immediately
                    transferPlayback(0);
                });
        })
        .catch(function(err) {
            console.log('%d - Something went wrong!', debug_id, err);
        });
}

function spotifyStopPlay(deviceName, debug_id) {
    spotifyApi.setAccessToken(process.env.spotifyRefreshToken);
    spotifyApi.setCredentials({
        'refreshToken': process.env.spotifyRefreshToken
    });

    spotifyApi.refreshAccessToken()
        .then(function(data) {
            spotifyApi.setAccessToken(data.body['access_token']);
            console.log("%d - Refreshed Spotify Auth Token", debug_id);

            return spotifyApi.getMyDevices();
        })
        .then(function(devicesData) {
            var targetDevice = devicesData.body.devices.find(device => device.name === deviceName);

            if (!targetDevice) {
                console.log("%d - Device not found: %s", debug_id, deviceName);
                return Promise.reject('Device not found');
            }

            return spotifyApi.getMyCurrentPlaybackState();
        })
        .then(function(playbackData) {
            if (playbackData.body && playbackData.body.device && playbackData.body.device.name === deviceName) {
                return spotifyApi.pause();
            } else {
                console.log("%d - Target device is not currently active: %s", debug_id, deviceName);
                return Promise.reject('Target device is not currently active');
            }
        })
        .then(function() {
            console.log("%d - Playback paused on device: %s", debug_id, deviceName);
        })
        .catch(function(err) {
            if (typeof err === 'string') {
                // Custom error message
                console.log('%d - Error:', debug_id, err);
            } else {
                // API error
                console.log('%d - Error pausing playback on device:', debug_id, err);
            }
        });
}

module.exports = {
	spotifySwitchPlay,
    spotifyStopPlay
}