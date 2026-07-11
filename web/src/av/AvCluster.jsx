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

import { useState } from 'preact/hooks';
import { commands } from '../state/index.js';
import VolumeBar from './VolumeBar.jsx';
import AvDrillIn from './AvDrillIn.jsx';

const FONT = "'Outfit', system-ui, sans-serif";
const ROW_BORDER = '1px solid rgba(234, 229, 239, 0.11)';
const ROW_BG = 'rgba(234, 229, 239, 0.03)';

// Receiver input number (entry.live.input) -> device-scene id, best-effort so
// the INPUT segmented group can highlight the currently-active source. Not
// exhaustive (e.g. input 6 has no device scene / quick pick here).
const INPUT_NUMBER_TO_SCENE_ID = {
  1: 'appleTv',
  4: 'chromeCast',
  5: 'spotifyServerLivingRoom',
};

// Receiver input number -> display label, for the slim "current source" chip.
const INPUT_NUMBER_TO_LABEL = {
  1: 'Apple TV',
  4: 'Chromecast',
  5: 'Spotify',
  6: 'Input 6',
};

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
 * the OFF slim state and the ON state's expanded source chip. */
function SourcePicker({ inputScenes, activeSceneId }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      {inputScenes.map((scene) => {
        const active = scene.id === activeSceneId;
        return (
          <button
            key={scene.id}
            type="button"
            onClick={() => commands.avInputScene(scene.id, scene.label)}
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

  const live = (receiverEntry && receiverEntry.live) || {};
  const receiverOn = live.power === 'ON';
  // Only highlight a source while the receiver is actually on -- with the
  // receiver off, `live.input` is just the last-known value and shouldn't
  // render as "active" (it isn't driving anything right now).
  const activeSceneId = receiverOn ? INPUT_NUMBER_TO_SCENE_ID[live.input] : null;
  const activeLabel = INPUT_NUMBER_TO_LABEL[live.input] || 'Unknown source';

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
          <Pill on={Boolean(live.mute)} onClick={() => commands.avMute(receiverEntry)}>
            {live.mute ? 'Muted' : 'Mute'}
          </Pill>
        )}
      </div>

      {!receiverOn ? (
        // OFF: nothing but the source picker -- picking one powers on + selects.
        <SourcePicker inputScenes={inputScenes} activeSceneId={activeSceneId} />
      ) : (
        <>
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

          <button
            type="button"
            onClick={() => setSourceOpen((o) => !o)}
            style={{
              alignSelf: 'flex-start',
              padding: '6px 12px',
              borderRadius: 'var(--r-pill, 999px)',
              border: ROW_BORDER,
              background: ROW_BG,
              color: 'var(--text-secondary, rgba(234, 229, 239, 0.55))',
              fontFamily: FONT,
              fontWeight: 500,
              fontSize: 12,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            {activeLabel} {sourceOpen ? '▴' : '▾'}
          </button>

          {sourceOpen && <SourcePicker inputScenes={inputScenes} activeSceneId={activeSceneId} />}
        </>
      )}

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
