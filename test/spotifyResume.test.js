/**
 * Unit tests for src/spotify.js's spotifyResume (Dashboard increment 4).
 *
 * spotifyResume is meant to be a LIGHTWEIGHT resume for the now-playing
 * card's play/pause toggle: it must call spotifyApi.play() with NO
 * device_id, so playback continues on whatever Spotify Connect device is
 * currently active rather than re-transferring to the Echo (that's
 * spotifySwitchPlay's job, tested elsewhere by hand/integration since it
 * needs getMyDevices()/transferMyPlayback()).
 *
 * spotify-web-api-node's SpotifyWebApi instance is created once at module
 * load (`spotifyApi = new SpotifyWebApi(...)`), so tests monkey-patch the
 * shared prototype's play/refreshAccessToken/setAccessToken/setCredentials
 * before requiring src/spotify.js -- the same instance methods are used by
 * every test in this file, restored in afterEach so nothing leaks into
 * other test files' Spotify-related tests (e.g. test/spotifyNowPlaying.test.js).
 */

const assert = require('node:assert');
const { test, beforeEach, afterEach } = require('node:test');

const SpotifyWebApi = require('spotify-web-api-node');

const originalPlay = SpotifyWebApi.prototype.play;
const originalRefresh = SpotifyWebApi.prototype.refreshAccessToken;
const originalSetAccessToken = SpotifyWebApi.prototype.setAccessToken;
const originalSetCredentials = SpotifyWebApi.prototype.setCredentials;
const originalRefreshToken = process.env.spotifyRefreshToken;

let playCalls;

beforeEach(() => {
    playCalls = [];
    process.env.spotifyRefreshToken = 'fake-refresh-token';

    SpotifyWebApi.prototype.setAccessToken = function() {};
    SpotifyWebApi.prototype.setCredentials = function() {};
    SpotifyWebApi.prototype.refreshAccessToken = function() {
        return Promise.resolve({ body: { access_token: 'fake-access-token' } });
    };
    SpotifyWebApi.prototype.play = function(...args) {
        playCalls.push(args);
        return Promise.resolve();
    };
});

afterEach(() => {
    SpotifyWebApi.prototype.play = originalPlay;
    SpotifyWebApi.prototype.refreshAccessToken = originalRefresh;
    SpotifyWebApi.prototype.setAccessToken = originalSetAccessToken;
    SpotifyWebApi.prototype.setCredentials = originalSetCredentials;
    if (originalRefreshToken === undefined) {
        delete process.env.spotifyRefreshToken;
    } else {
        process.env.spotifyRefreshToken = originalRefreshToken;
    }
    delete require.cache[require.resolve('../src/spotify')];
});

test('spotifyResume calls play() with no arguments (no device_id, no re-transfer)', async () => {
    // eslint-disable-next-line global-require
    const { spotifyResume } = require('../src/spotify');

    await spotifyResume(1);

    assert.strictEqual(playCalls.length, 1, 'expected play() to be called exactly once');
    assert.deepStrictEqual(playCalls[0], [], 'expected play() to be called with no arguments (resumes on the active device)');
});

test('spotifyResume resolves (does not throw) when play() rejects', async () => {
    SpotifyWebApi.prototype.play = function(...args) {
        playCalls.push(args);
        return Promise.reject(new Error('boom'));
    };
    delete require.cache[require.resolve('../src/spotify')];
    // eslint-disable-next-line global-require
    const { spotifyResume } = require('../src/spotify');

    await assert.doesNotReject(() => spotifyResume(2));
    assert.strictEqual(playCalls.length, 1);
});

test('spotifyResume resolves (does not throw) when refreshAccessToken() rejects', async () => {
    SpotifyWebApi.prototype.refreshAccessToken = function() {
        return Promise.reject(new Error('auth failure'));
    };
    delete require.cache[require.resolve('../src/spotify')];
    // eslint-disable-next-line global-require
    const { spotifyResume } = require('../src/spotify');

    await assert.doesNotReject(() => spotifyResume(3));
    assert.strictEqual(playCalls.length, 0, 'play() should never be called if the token refresh failed');
});
