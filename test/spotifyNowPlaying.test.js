/**
 * Unit tests for src/spotify.js's _buildNowPlayingPayload (Stage 9, issue #22).
 *
 * Pure function tests only -- no network, no MQTT broker, no Spotify API.
 * spotify.js's top-level `new SpotifyWebApi(...)` and `require('./mqttClient')`
 * are both side-effect-free at require time (mqttClient.js only connects when
 * its own connect() is called explicitly), so requiring src/spotify.js here
 * is safe and never boots index.js or touches the network.
 */

const assert = require('node:assert');
const { test } = require('node:test');

const { _buildNowPlayingPayload } = require('../src/spotify');

test('playing: extracts track, artist, albumArt, device, isPlaying true', () => {
    const body = {
        is_playing: true,
        item: {
            name: 'Song Title',
            artists: [{ name: 'The Artist' }, { name: 'Featured Artist' }],
            album: {
                images: [
                    { url: 'https://example.com/big.jpg', height: 640 },
                    { url: 'https://example.com/small.jpg', height: 64 },
                ],
            },
        },
        device: { name: "Ray's Echo" },
    };

    const payload = _buildNowPlayingPayload(body);

    assert.strictEqual(payload.track, 'Song Title');
    assert.strictEqual(payload.artist, 'The Artist');
    assert.strictEqual(payload.albumArt, 'https://example.com/big.jpg');
    assert.strictEqual(payload.isPlaying, true);
    assert.strictEqual(payload.device, "Ray's Echo");
    assert.strictEqual(payload.source, 'poll');
    assert.ok(Number.isFinite(payload.timestamp));
});

test('nothing playing (no active device): body has is_playing but no item', () => {
    const payload = _buildNowPlayingPayload({ is_playing: false });

    assert.strictEqual(payload.isPlaying, false);
    assert.strictEqual(payload.track, undefined);
    assert.strictEqual(payload.artist, undefined);
    assert.strictEqual(payload.source, 'poll');
    assert.ok(Number.isFinite(payload.timestamp));
});

test('nothing playing: Spotify\'s 204-empty-body case (empty string body)', () => {
    const payload = _buildNowPlayingPayload('');

    assert.deepStrictEqual(Object.keys(payload).sort(), ['isPlaying', 'source', 'timestamp']);
    assert.strictEqual(payload.isPlaying, false);
});

test('malformed body: undefined never throws, returns safe minimal payload', () => {
    assert.doesNotThrow(() => _buildNowPlayingPayload(undefined));
    const payload = _buildNowPlayingPayload(undefined);
    assert.strictEqual(payload.isPlaying, false);
    assert.strictEqual(payload.source, 'poll');
});

test('malformed body: null never throws', () => {
    assert.doesNotThrow(() => _buildNowPlayingPayload(null));
    assert.strictEqual(_buildNowPlayingPayload(null).isPlaying, false);
});

test('malformed body: item present but missing artists/album/device never throws', () => {
    const payload = _buildNowPlayingPayload({ is_playing: true, item: { name: 'Solo Track' } });

    assert.strictEqual(payload.track, 'Solo Track');
    assert.strictEqual(payload.artist, null);
    assert.strictEqual(payload.albumArt, null);
    assert.strictEqual(payload.device, null);
    assert.strictEqual(payload.isPlaying, true);
});

test('malformed body: deeply wrong shapes (numbers/arrays where objects expected) never throw', () => {
    assert.doesNotThrow(() => _buildNowPlayingPayload({ item: { name: 42, artists: 'not-an-array', album: null }, device: 'not-an-object' }));
    const payload = _buildNowPlayingPayload({ item: { name: 42, artists: 'not-an-array', album: null }, device: 'not-an-object' });
    assert.strictEqual(payload.track, null);
    assert.strictEqual(payload.artist, null);
    assert.strictEqual(payload.albumArt, null);
    assert.strictEqual(payload.device, null);
});
