// Apollo v2 dashboard -- AV increment 5: the pinned-footer AV block. Slim by
// default (one compact strip), expanding into the full raw/diagnostics
// surface behind "All controls ›" (AvDrillIn, increment 4) which this
// component now owns and opens itself -- see the note on `drillInOpen` below.
//
// Slim states:
//   - receiver OFF: just a source picker (device-scene INPUT buttons). Firing
//     one powers the receiver on *and* selects, via avInputScene.
//   - receiver ON: Off button + volume bar + mute, plus a compact source chip
//     that expands into the same INPUT picker in place (no drill-in needed
//     for the common "switch source" action).
// The projector control lives only in AvDrillIn now -- it's a less-common
// action than anything above, so it doesn't cost slim-footer space here.

import { useEffect, useState } from 'preact/hooks';
import { commands } from '../state/index.js';
import VolumeBar from './VolumeBar.jsx';
import AvDrillIn from './AvDrillIn.jsx';
import './av.css';

const FONT = "'Outfit', system-ui, sans-serif";
const ROW_BORDER = '1px solid rgba(234, 229, 239, 0.11)';
const ROW_BG = 'rgba(234, 229, 239, 0.03)';

// The device-scene id NowPlaying.jsx / RoomPanel treat as "Spotify is the
// receiver's active source" -- single source of truth for both the INPUT
// picker below and `isSpotifyInputNumber`.
const SPOTIFY_SCENE_ID = 'spotifyServerLivingRoom';

// Receiver input number (entry.live.input) -> device-scene id, best-effort so
// the INPUT segmented group can highlight the currently-active source. Not
// exhaustive (e.g. input 6 has no device scene / quick pick here).
const INPUT_NUMBER_TO_SCENE_ID = {
  1: 'appleTv',
  4: 'chromeCast',
  5: SPOTIFY_SCENE_ID,
};

// Reverse of the above, built once -- lets a tap on a source button look up
// the input number it's expected to land on, to drive the "pending" chase
// animation until the live state confirms it (see `handleSelectInput`).
const SCENE_ID_TO_INPUT_NUMBER = Object.fromEntries(
  Object.entries(INPUT_NUMBER_TO_SCENE_ID).map(([number, sceneId]) => [sceneId, Number(number)])
);

// Receiver input number -> display label, for the slim "current source" chip.
const INPUT_NUMBER_TO_LABEL = {
  1: 'Apple TV',
  4: 'Chromecast',
  5: 'Spotify',
  6: 'Input 6',
};

/** How long a tapped source button stays "pending" before quietly giving up
 * and reverting to the picker if the live state never confirms it. */
const PENDING_TIMEOUT_MS = 20000;

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

function Pill({ on, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: '5px 14px',
        borderRadius: 'var(--r-pill, 999px)',
        border: on ? '1px solid var(--accent, #a688e8)' : '1px solid rgba(234, 229, 239, 0.15)',
        background: on ? 'var(--accent-fill, rgba(166, 136, 232, 0.16))' : 'rgba(234, 229, 239, 0.05)',
        color: on ? 'var(--text, #eae5ef)' : 'var(--text-secondary, rgba(234, 229, 239, 0.55))',
        fontFamily: FONT,
        fontWeight: 500,
        fontSize: 11.5,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        flexShrink: 0,
      }}
    >
      {children}
    </button>
  );
}

function SectionLabel({ children }) {
  return (
    <span
      style={{
        fontFamily: FONT,
        fontWeight: 500,
        fontSize: 11,
        letterSpacing: '0.14em',
        textTransform: 'uppercase',
        color: 'rgba(234, 229, 239, 0.45)',
      }}
    >
      {children}
    </span>
  );
}

function AllControlsLink({ onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        background: 'transparent',
        border: 'none',
        color: 'var(--accent, #a688e8)',
        fontFamily: FONT,
        fontWeight: 500,
        fontSize: 11,
        cursor: 'pointer',
        padding: 0,
        whiteSpace: 'nowrap',
      }}
    >
      All controls &rsaquo;
    </button>
  );
}

/** The INPUT device-scene picker -- fires a full device scene (input + video
 * routing + keypad blink), not the receiver's raw input command. Shared by
 * the OFF slim state and the ON state's expanded source chip. A button whose
 * scene id matches `pendingSceneId` shows the rotating "confirming" chase
 * border (see .av-input-pending in av.css) until the tap is confirmed or
 * times out -- see `handleSelectInput` in AvCluster. */
function SourcePicker({ inputScenes, activeSceneId, pendingSceneId, onSelect }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      {inputScenes.map((scene) => {
        const active = scene.id === activeSceneId;
        const pending = scene.id === pendingSceneId;
        return (
          <button
            key={scene.id}
            type="button"
            className={pending ? 'av-input-pending' : undefined}
            onClick={() => onSelect(scene)}
            style={{
              padding: '7px 13px',
              borderRadius: 'var(--r-row, 11px)',
              border: active ? '1px solid var(--accent, #a688e8)' : ROW_BORDER,
              background: active ? 'var(--accent-fill, rgba(166, 136, 232, 0.16))' : ROW_BG,
              color: active ? 'var(--text, #eae5ef)' : 'var(--text-secondary, rgba(234, 229, 239, 0.55))',
              fontFamily: FONT,
              fontWeight: 500,
              fontSize: 12,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            {scene.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * @param {object} props
 * @param {object} props.receiverEntry - the Anthem receiver DEVICES entry
 * @param {object} props.projectorEntry - the projector DEVICES entry (now
 *   only surfaced inside AvDrillIn, not the slim cluster)
 * @param {Array<{id:string,label:string}>} props.inputScenes - device scenes
 *   for the INPUT buttons, e.g. Apple TV / Chromecast / Spotify
 */
function AvCluster({ receiverEntry, projectorEntry, inputScenes }) {
  // Self-contained drill-in state: this component owns opening/closing its
  // own AvDrillIn rather than expecting a parent-supplied onShowControls --
  // the parent (RoomPanel) never wired that up, so "All controls ›" was
  // previously a dead button. Same pattern ClimateCluster already uses.
  const [drillInOpen, setDrillInOpen] = useState(false);
  // Slim ON state keeps the source picker collapsed behind a chip until
  // tapped, so switching source doesn't cost permanent footer height.
  const [sourceOpen, setSourceOpen] = useState(false);
  // The source button most recently tapped while its confirmation hasn't
  // landed yet -- drives the rotating "confirming" chase border on that one
  // button (see SourcePicker/.av-input-pending) until `live` confirms it or
  // PENDING_TIMEOUT_MS elapses, whichever comes first.
  const [pendingInput, setPendingInput] = useState(null);

  const live = (receiverEntry && receiverEntry.live) || {};
  const receiverOn = live.power === 'ON';
  // Only highlight a source while the receiver is actually on -- with the
  // receiver off, `live.input` is just the last-known value and shouldn't
  // render as "active" (it isn't driving anything right now).
  const activeSceneId = receiverOn ? INPUT_NUMBER_TO_SCENE_ID[live.input] : null;
  const activeLabel = INPUT_NUMBER_TO_LABEL[live.input] || 'Unknown source';

  // A tap fires immediately (as before) but, when the tapped scene maps to a
  // known input number, also arms the pending/confirming indicator -- most
  // sources take a beat to actually land (receiver power-on + input switch
  // aren't instant), so this gives feedback the tap registered instead of the
  // UI just sitting there until the on-state controls pop in.
  function handleSelectInput(scene) {
    commands.avInputScene(scene.id, scene.label);
    const number = SCENE_ID_TO_INPUT_NUMBER[scene.id];
    if (number != null) {
      setPendingInput({ sceneId: scene.id, number });
    }
  }

  // Give up on a pending confirmation after PENDING_TIMEOUT_MS -- quietly:
  // just stop showing the chase, no error UI (see task doc).
  useEffect(() => {
    if (!pendingInput) return undefined;
    const timer = setTimeout(() => {
      setPendingInput((current) => (current === pendingInput ? null : current));
    }, PENDING_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [pendingInput]);

  // Clear the pending indicator as soon as the live state actually confirms
  // it: receiver on AND its input matches the number we're waiting for.
  useEffect(() => {
    if (pendingInput && receiverOn && live.input === pendingInput.number) {
      setPendingInput(null);
    }
  }, [pendingInput, receiverOn, live.input]);

  return (
    <div
      style={{
        paddingTop: 10,
        borderTop: '1px solid var(--hairline, rgba(234, 229, 239, 0.1))',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <SectionLabel>Receiver</SectionLabel>
        <AllControlsLink onClick={() => setDrillInOpen(true)} />
        <div style={{ flex: 1 }} />
        {receiverOn && (
          <>
            {/* Task 5c: the source chip lives inline next to Mute now, instead
                of on its own row below the volume bar. */}
            <button
              type="button"
              onClick={() => setSourceOpen((o) => !o)}
              style={{
                padding: '5px 10px',
                borderRadius: 'var(--r-pill, 999px)',
                border: ROW_BORDER,
                background: ROW_BG,
                color: 'var(--text-secondary, rgba(234, 229, 239, 0.55))',
                fontFamily: FONT,
                fontWeight: 500,
                fontSize: 11,
                cursor: 'pointer',
                whiteSpace: 'nowrap',
                flexShrink: 0,
              }}
            >
              {activeLabel} {sourceOpen ? '▴' : '▾'}
            </button>
            <Pill on={Boolean(live.mute)} onClick={() => commands.avMute(receiverEntry)}>
              {live.mute ? 'Muted' : 'Mute'}
            </Pill>
          </>
        )}
      </div>

      {/* Both states stay mounted as a pair of drawers (rather than a hard
          conditional mount) so the ON-state reveal eases open instead of
          popping in the instant the receiver confirms power-on -- and so the
          reverse (turning off) eases closed too. Wrapped together with no
          gap of their own so the collapsed one (max-height:0) doesn't still
          reserve a flex `gap` of empty space next to the visible one. */}
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <div className={`av-drawer${!receiverOn ? ' is-open' : ''}`}>
          <div className="av-drawer-inner">
            <SourcePicker
              inputScenes={inputScenes}
              activeSceneId={activeSceneId}
              pendingSceneId={pendingInput && pendingInput.sceneId}
              onSelect={handleSelectInput}
            />
          </div>
        </div>

        <div className={`av-drawer${receiverOn ? ' is-open' : ''}`}>
          <div className="av-drawer-inner">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Pill on={false} onClick={() => commands.avPower(receiverEntry, false)}>
                Off
              </Pill>
              <div style={{ flex: 1, minWidth: 0 }}>
                <VolumeBar
                  compact
                  db={typeof live.volume === 'number' ? live.volume : -80}
                  disabled={false}
                  onChange={(db) => commands.avVolume(receiverEntry, db)}
                />
              </div>
            </div>

            {sourceOpen && (
              <div style={{ marginTop: 8 }}>
                <SourcePicker
                  inputScenes={inputScenes}
                  activeSceneId={activeSceneId}
                  pendingSceneId={pendingInput && pendingInput.sceneId}
                  onSelect={handleSelectInput}
                />
              </div>
            )}
          </div>
        </div>
      </div>

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

export default AvCluster;
