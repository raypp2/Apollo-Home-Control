// Apollo v2 dashboard -- AV increment 4: now-playing strip. Sits above the
// AV cluster in the room panel, reading the single global `store.spotify`
// signal (Apollo has one Spotify account/session, not one per room -- the
// panel decides whether to render this at all based on the room's config).

import { useState } from 'preact/hooks';
import { store, commands } from '../state/index.js';
import './av.css';

const FONT = "'Outfit', system-ui, sans-serif";
const STRIP_HEIGHT = 72;
const ART_SIZE = 44;

function Equalizer() {
  return (
    <div
      aria-hidden="true"
      style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 14, flexShrink: 0 }}
    >
      <span className="av-eq-bar" />
      <span className="av-eq-bar" />
      <span className="av-eq-bar" />
    </div>
  );
}

function AlbumArt({ src }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) {
    return (
      <div
        aria-hidden="true"
        style={{
          width: ART_SIZE,
          height: ART_SIZE,
          borderRadius: 8,
          flexShrink: 0,
          background: 'rgba(234, 229, 239, 0.06)',
          border: '1px solid rgba(234, 229, 239, 0.11)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 16,
          color: 'var(--text-tertiary, rgba(234, 229, 239, 0.32))',
        }}
      >
        ♪
      </div>
    );
  }
  return (
    <img
      src={src}
      alt=""
      referrerpolicy="no-referrer"
      onError={() => setFailed(true)}
      style={{
        width: ART_SIZE,
        height: ART_SIZE,
        borderRadius: 8,
        flexShrink: 0,
        objectFit: 'cover',
        border: '1px solid rgba(234, 229, 239, 0.11)',
      }}
    />
  );
}

/**
 * @param {object} props
 * @param {object} props.spotifyEntry - the Spotify device/config entry, passed
 *   through to commands.spotifyPlayPause (not read from the store -- that's
 *   the now-playing payload, a separate thing from the device entry).
 */
function NowPlaying({ spotifyEntry }) {
  const nowPlaying = store.spotify.value;
  const nothingPlaying = !nowPlaying || nowPlaying.reachable === false;

  return (
    <div
      style={{
        height: STRIP_HEIGHT,
        flexShrink: 0,
        borderTop: '1px solid var(--hairline, rgba(234, 229, 239, 0.1))',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '0 2px',
      }}
    >
      {nothingPlaying ? (
        <>
          <AlbumArt src={null} />
          <div
            style={{
              fontFamily: FONT,
              fontWeight: 300,
              fontSize: 12,
              color: 'var(--text-tertiary, rgba(234, 229, 239, 0.32))',
            }}
          >
            Nothing playing
          </div>
        </>
      ) : (
        <>
          <AlbumArt src={nowPlaying.albumArt} />
          <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, gap: 2 }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                minWidth: 0,
              }}
            >
              <span
                style={{
                  fontFamily: FONT,
                  fontWeight: 500,
                  fontSize: 13,
                  color: 'var(--text, #eae5ef)',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  minWidth: 0,
                }}
              >
                {nowPlaying.track || 'Unknown track'}
              </span>
              {nowPlaying.isPlaying && <Equalizer />}
            </div>
            <span
              style={{
                fontFamily: FONT,
                fontWeight: 300,
                fontSize: 11,
                color: 'rgba(234, 229, 239, 0.4)',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {[nowPlaying.artist, 'Spotify', nowPlaying.device].filter(Boolean).join(' · ')}
            </span>
          </div>
          <button
            type="button"
            aria-label={nowPlaying.isPlaying ? 'Pause' : 'Play'}
            onClick={() => commands.spotifyPlayPause(spotifyEntry, nowPlaying.isPlaying)}
            style={{
              width: 36,
              height: 36,
              flexShrink: 0,
              borderRadius: 'var(--r-pill, 999px)',
              border: '1px solid rgba(234, 229, 239, 0.15)',
              background: 'rgba(234, 229, 239, 0.05)',
              color: 'var(--text, #eae5ef)',
              fontSize: 14,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
            }}
          >
            {nowPlaying.isPlaying ? '❚❚' : '▶'}
          </button>
        </>
      )}
    </div>
  );
}

export default NowPlaying;
