// Apollo v2 dashboard -- mobile "next" layout: full receiver controls. Power
// lives here (the Dock never shows a power button). Reuses AvDrillIn as-is
// for "All controls ›" (raw inputs, diagnostics, power/input query) and
// NowPlaying as-is for the Spotify strip -- both already self-contained
// panel.css-free components driven entirely by props/commands.

import { useState } from 'preact/hooks';
import { store, commands } from '../state/index.js';
import { AvDrillIn, NowPlaying, isSpotifyInputNumber } from '../av/index.js';
import { INPUT_NUMBER_TO_SCENE_ID } from '../av/sources.js';
import VolumeControl from './VolumeControl.jsx';
import './dock.css';

function MutePillIcon({ muted }) {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M4 9v6h4l5 4V5L8 9H4Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      {muted && <path d="M16 9l5 6M21 9l-5 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />}
    </svg>
  );
}

/**
 * Full receiver tab. Finds its own entries from the store (same predicates
 * RoomPanel uses -- see there for why: one receiver, one AC, one Spotify
 * account, searched across every device rather than the selected room).
 */
function MediaTab() {
  const [drillInOpen, setDrillInOpen] = useState(false);

  const devices = [...store.devices.value.values()];
  const receiverEntry = devices.find((e) => e.speaker) || null;
  const projectorEntry = devices.find((e) => e.type === 'ip_control' && !e.speaker) || null;
  const spotifyEntry = devices.find((e) => e.type === 'spotify') || null;

  if (!receiverEntry) {
    return <div className="next-status-text">No receiver configured.</div>;
  }

  const live = receiverEntry.live || {};
  const on = live.power === 'ON';
  const spotifyActive = Boolean(spotifyEntry && on && isSpotifyInputNumber(live.input));
  const inputScenes = store.deviceScenes.value.map((s) => ({ id: s.id, label: s.title }));
  const activeSceneId = on ? INPUT_NUMBER_TO_SCENE_ID[live.input] || null : null;
  const projectorOn = projectorEntry ? commands.deviceView(projectorEntry).on : false;

  return (
    <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div className="next-power-row">
        <button
          type="button"
          className={`next-power-btn${on ? ' next-on-accent' : ''}`}
          onClick={() => commands.avPower(receiverEntry, !on)}
        >
          {on ? 'Turn off' : 'Turn on'}
        </button>
        <span className="next-status-text">Receiver {on ? 'on' : 'off'}</span>
      </div>

      {spotifyEntry && <NowPlaying spotifyEntry={spotifyEntry} open={spotifyActive} />}

      <div>
        <div className="next-status-text" style={{ marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
          Source
        </div>
        <div className="next-media-source-grid">
          {inputScenes.map((scene) => (
            <button
              key={scene.id}
              type="button"
              className={`next-media-source-tile${scene.id === activeSceneId ? ' next-on-accent' : ''}`}
              onClick={() => commands.avInputScene(scene.id, scene.label)}
            >
              {scene.label}
            </button>
          ))}
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <button
          type="button"
          aria-label={live.mute ? 'Unmute' : 'Mute'}
          className={`next-power-btn${live.mute ? ' next-on-accent' : ''}`}
          onClick={() => commands.avMute(receiverEntry)}
          style={{ display: 'flex', alignItems: 'center', gap: 6 }}
        >
          <MutePillIcon muted={Boolean(live.mute)} />
          {live.mute ? 'Muted' : 'Mute'}
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <VolumeControl
            db={typeof live.volume === 'number' ? live.volume : -80}
            muted={Boolean(live.mute)}
            height={44}
            onChange={(db) => commands.avVolume(receiverEntry, db)}
          />
        </div>
      </div>

      {projectorEntry && (
        <div>
          <div className="next-status-text" style={{ marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            Projector
          </div>
          <div className="next-segmented">
            <button
              type="button"
              className={`next-segmented-btn${projectorOn ? ' next-on-accent' : ''}`}
              onClick={() => commands.momentary(projectorEntry, ['on'], 'Projector on')}
            >
              On
            </button>
            <button
              type="button"
              className={`next-segmented-btn${!projectorOn ? ' next-on-accent' : ''}`}
              onClick={() => commands.momentary(projectorEntry, ['off'], 'Projector off')}
            >
              Off
            </button>
          </div>
        </div>
      )}

      <button type="button" className="next-all-controls-link" onClick={() => setDrillInOpen(true)}>
        All controls &rsaquo;
      </button>

      {drillInOpen && (
        <AvDrillIn
          receiverEntry={receiverEntry}
          projectorEntry={projectorEntry}
          onBack={() => setDrillInOpen(false)}
        />
      )}
    </div>
  );
}

export default MediaTab;
