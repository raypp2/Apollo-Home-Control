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

const DRY_RUN = process.env.APOLLO_DRY_RUN === '1';

// Stage 9 of the MQTT plan (issue #22) -- publishes what's currently playing
// on Spotify to the bus every 10s so the dashboard can show a now-playing
// card (Stage 11 builds the card; this stage only puts the data on the bus).
// mqttClient never requires('../index'), so it's safe to require directly
// here (see the module doc comment at the top of mqttClient.js).
const mqttClient = require('./mqttClient');

const NOW_PLAYING_TOPIC = 'apollo/home/spotify/player/state';
const NOW_PLAYING_INTERVAL_MS = 10000;

let nowPlayingTimer = null;
// Tracks whether we're currently in an auth/API outage, so the "keep trying,
// but don't spam the log or the (retained) topic" behavior only logs/publishes
// once per outage -- on the transition into the outage, not on every 10s tick.
let nowPlayingOutage = false;

/**
 * Builds the retained `apollo/home/spotify/player/state` payload from a
 * spotify-web-api-node `getMyCurrentPlaybackState()` response body. Pure and
 * defensive: never throws, regardless of how malformed/empty `playbackBody`
 * is (no active device returns an empty 204 body from Spotify's API, which
 * spotify-web-api-node surfaces as `body` being `''` or `undefined`).
 * Exported for testing (test/spotifyNowPlaying.test.js).
 * @param {object|string|undefined|null} playbackBody - the `.body` of a
 *   getMyCurrentPlaybackState() response
 * @returns {{track: (string|null), artist: (string|null), albumArt: (string|null),
 *            isPlaying: boolean, device: (string|null), timestamp: number,
 *            source: "poll"}}
 */
function _buildNowPlayingPayload(playbackBody) {
    const timestamp = Math.floor(Date.now() / 1000);

    try {
        if (!playbackBody || typeof playbackBody !== 'object' || !playbackBody.item) {
            // Nothing playing (or malformed/empty body) -- safe minimal payload.
            return { isPlaying: false, timestamp, source: 'poll' };
        }

        const item = playbackBody.item;
        const track = (typeof item.name === 'string') ? item.name : null;
        const artist = (item.artists && item.artists[0] && typeof item.artists[0].name === 'string')
            ? item.artists[0].name
            : null;
        const albumArt = (item.album && Array.isArray(item.album.images) && item.album.images[0]
            && typeof item.album.images[0].url === 'string')
            ? item.album.images[0].url
            : null;
        const device = (playbackBody.device && typeof playbackBody.device.name === 'string')
            ? playbackBody.device.name
            : null;

        return {
            track,
            artist,
            albumArt,
            isPlaying: !!playbackBody.is_playing,
            device,
            timestamp,
            source: 'poll',
        };
    } catch {
        // Never let an unexpected response shape throw here.
        return { isPlaying: false, timestamp, source: 'poll' };
    }
}

/**
 * One poll tick: refreshes the Spotify access token, fetches current
 * playback state, and publishes the retained now-playing payload. On any
 * auth/API error, logs once per outage (not per tick), publishes a single
 * `{isPlaying:false, reachable:false, ...}` payload for that outage, and
 * keeps trying on the next tick -- it never stops the timer.
 */
function pollNowPlaying() {
    spotifyApi.setAccessToken(process.env.spotifyRefreshToken);
    spotifyApi.setCredentials({
        'refreshToken': process.env.spotifyRefreshToken
    });

    spotifyApi.refreshAccessToken()
        .then(function(data) {
            spotifyApi.setAccessToken(data.body['access_token']);
            return spotifyApi.getMyCurrentPlaybackState();
        })
        .then(function(playbackData) {
            nowPlayingOutage = false;
            const payload = _buildNowPlayingPayload(playbackData && playbackData.body);
            mqttClient.publish(NOW_PLAYING_TOPIC, payload, { qos: 1, retain: true });
        })
        .catch(function(err) {
            if (!nowPlayingOutage) {
                nowPlayingOutage = true;
                console.log('Spotify now-playing: polling error (suppressing repeats until recovery): %s', (err && err.message) || err);
                mqttClient.publish(NOW_PLAYING_TOPIC, {
                    isPlaying: false,
                    reachable: false,
                    timestamp: Math.floor(Date.now() / 1000),
                    source: 'poll',
                }, { qos: 1, retain: true });
            }
        });
}

/**
 * Starts the 10s now-playing poller (gated behind SPOTIFY_NOW_PLAYING=1 in
 * index.js -- see that module's comment for why it's opt-in). Idempotent:
 * calling twice is a no-op. The timer is unref'd so it never keeps the
 * process alive on its own, matching the pattern used by healthMonitor.js's
 * timers.
 */
function startNowPlayingPublisher() {
    if (nowPlayingTimer) {
        return;
    }

    pollNowPlaying(); // don't wait a full 10s for the first publish

    nowPlayingTimer = setInterval(pollNowPlaying, NOW_PLAYING_INTERVAL_MS);
    if (typeof nowPlayingTimer.unref === 'function') {
        nowPlayingTimer.unref();
    }
}

function spotifySwitchPlay(deviceName, context_uri, debug_id) {

	if (DRY_RUN) {
		console.log("%d - DRY RUN, would switch Spotify playback to device: %s (context: %s)", debug_id, deviceName, context_uri);
		return;
	}

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
                            setTimeout(() => transferPlayback(num + 1), attempt_delay);
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

    if (DRY_RUN) {
        console.log("%d - DRY RUN, would stop Spotify playback on device: %s", debug_id, deviceName);
        return;
    }

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

/**
 * Lightweight resume: calls play() with NO device_id, so playback resumes on
 * whatever Spotify Connect device is currently active rather than
 * re-transferring to the Echo (that's spotifySwitchPlay's job). Used by the
 * now-playing card's play/pause toggle (`/api/DEVICES/lrEchoSpotify/play`),
 * where playback is already on the intended device and just needs to
 * continue.
 * @param {number} debug_id
 * @returns {Promise<void>|undefined} undefined in DRY_RUN
 */
function spotifyResume(debug_id) {

    if (DRY_RUN) {
        console.log("%d - DRY RUN, would resume Spotify playback", debug_id);
        return;
    }

    spotifyApi.setAccessToken(process.env.spotifyRefreshToken);
    spotifyApi.setCredentials({
        'refreshToken': process.env.spotifyRefreshToken
    });

    return spotifyApi.refreshAccessToken()
        .then(function(data) {
            spotifyApi.setAccessToken(data.body['access_token']);
            console.log("%d - Refreshed Spotify Auth Token", debug_id);

            return spotifyApi.play();
        })
        .then(function() {
            console.log("%d - Resumed Spotify playback", debug_id);
        })
        .catch(function(err) {
            console.log('%d - Error resuming Spotify playback:', debug_id, err);
        });
}

module.exports = {
	spotifySwitchPlay,
    spotifyStopPlay,
    spotifyResume,
    startNowPlayingPublisher,
    _buildNowPlayingPayload,
}