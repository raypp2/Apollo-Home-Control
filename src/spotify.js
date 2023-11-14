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

function spotifySwitchPlay(deviceName, debug_id) {

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

                    function transferAttempt(num) {
                        if (playbackData.body.is_playing) {
                            spotifyApi.transferMyPlayback([deviceToSwitch])
                                .then(function(data) {
                                    console.log("%d - Transferred playback to: %s", debug_id, deviceName);
                                }, function(err) {
                                    handleTransferError(err, num);
                                });
                        } else {
                            // Add the play flag if not already playing
                            spotifyApi.transferMyPlayback([deviceToSwitch], {"play": true})
                                .then(function(data) {
                                    console.log("%d - Transferred Player & Started Playback on: %s", debug_id, deviceName);
                                }, function(err) {
                                    handleTransferError(err, num);
                                });
                        }
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
                    transferAttempt(0);
                });
        })
        .catch(function(err) {
            console.log('%d - Something went wrong!', debug_id, err);
        });
}

module.exports = {
	spotifySwitchPlay
}