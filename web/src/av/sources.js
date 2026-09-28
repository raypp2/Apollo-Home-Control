// Apollo v2 dashboard -- shared AV source list + receiver input-number
// mappings. Extracted out of AvCluster.jsx (mobile "next" layout increment)
// so the new Dock/MediaTab components can reuse the exact same source
// picker semantics (which device scene maps to which receiver input, and the
// display label for each) without duplicating the maps. AvCluster imports
// these back from here too -- this is a pure data move, no behavior change.

/** The device-scene id NowPlaying.jsx / RoomPanel treat as "Spotify is the
 * receiver's active source". */
export const SPOTIFY_SCENE_ID = 'spotifyServerLivingRoom';

/** Receiver input number (entry.live.input) -> device-scene id, best-effort
 * so a source picker can highlight the currently-active source. Not
 * exhaustive (e.g. input 6 has no device scene / quick pick). */
export const INPUT_NUMBER_TO_SCENE_ID = {
  1: 'appleTv',
  4: 'chromeCast',
  5: SPOTIFY_SCENE_ID,
};

/** Reverse of the above, built once -- lets a tap on a source button look up
 * the input number it's expected to land on, to drive a "pending" indicator
 * until the live state confirms it. */
export const SCENE_ID_TO_INPUT_NUMBER = Object.fromEntries(
  Object.entries(INPUT_NUMBER_TO_SCENE_ID).map(([number, sceneId]) => [sceneId, Number(number)])
);

/** Receiver input number -> display label. */
export const INPUT_NUMBER_TO_LABEL = {
  1: 'Apple TV',
  4: 'Chromecast',
  5: 'Spotify',
  6: 'Input 6',
};

/**
 * Whether `inputNumber` (entry.live.input) is the receiver input Spotify
 * plays through -- the condition NowPlaying/RoomPanel use to decide whether
 * the now-playing drawer should be open at all.
 * @param {number} inputNumber
 * @returns {boolean}
 */
export function isSpotifyInputNumber(inputNumber) {
  return INPUT_NUMBER_TO_SCENE_ID[inputNumber] === SPOTIFY_SCENE_ID;
}

/** How long a tapped source button stays "pending" before quietly giving up
 * and reverting to the picker if the live state never confirms it. Shared by
 * AvCluster's source picker, the Dock's "Choose source" popover, and
 * MediaTab's source grid. */
export const PENDING_TIMEOUT_MS = 20000;
