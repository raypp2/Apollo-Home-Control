// Apollo v2 dashboard -- AV increment 4: the bottom-of-panel AV block. One
// row for the receiver (power, input, volume, mute) and one for the
// projector. The full/raw receiver surface lives behind "All controls ›"
// in AvDrillIn.jsx -- this cluster only exposes the inputs that map to a
// full DEVICESCENES device scene (input + video routing + keypad blink),
// not the receiver's raw input commands.

import { commands } from '../state/index.js';
import VolumeBar from './VolumeBar.jsx';

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

/**
 * @param {object} props
 * @param {object} props.receiverEntry - the Anthem receiver DEVICES entry
 * @param {object} props.projectorEntry - the projector DEVICES entry
 * @param {Array<{id:string,label:string}>} props.inputScenes - device scenes
 *   for the INPUT segmented buttons, e.g. Apple TV / Chromecast / Spotify
 * @param {() => void} props.onShowControls - opens AvDrillIn
 */
function AvCluster({ receiverEntry, projectorEntry, inputScenes, onShowControls }) {
  const live = (receiverEntry && receiverEntry.live) || {};
  const receiverOn = live.power === 'ON';
  const activeSceneId = INPUT_NUMBER_TO_SCENE_ID[live.input];

  const projectorOn = commands.deviceView(projectorEntry).on;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* AV RECEIVER row */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <SectionLabel>AV Receiver</SectionLabel>
          <button
            type="button"
            onClick={onShowControls}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--accent, #a688e8)',
              fontFamily: FONT,
              fontWeight: 500,
              fontSize: 11,
              cursor: 'pointer',
              padding: 0,
            }}
          >
            All controls &rsaquo;
          </button>
          <div style={{ flex: 1 }} />
          <Pill on={Boolean(live.mute)} onClick={() => commands.avMute(receiverEntry)}>
            {live.mute ? 'Muted' : 'Mute'}
          </Pill>
          <Pill on={receiverOn} onClick={() => commands.avPower(receiverEntry, !receiverOn)}>
            {receiverOn ? 'On' : 'Off'}
          </Pill>
        </div>

        {/* INPUT segmented buttons -- always enabled; firing a device scene
            both selects the source and powers the receiver on server-side. */}
        <div>
          <div style={{ marginBottom: 6 }}>
            <SectionLabel>Input</SectionLabel>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {inputScenes.map((scene) => {
              const active = receiverOn && scene.id === activeSceneId;
              return (
                <button
                  key={scene.id}
                  type="button"
                  onClick={() => commands.avInputScene(scene.id, scene.label)}
                  style={{
                    padding: '7px 13px',
                    borderRadius: 'var(--r-row, 11px)',
                    border: active
                      ? '1px solid var(--accent, #a688e8)'
                      : ROW_BORDER,
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
        </div>

        <VolumeBar
          db={typeof live.volume === 'number' ? live.volume : -80}
          disabled={!receiverOn}
          onChange={(db) => commands.avVolume(receiverEntry, db)}
        />
      </div>

      {/* PROJECTOR row */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '10px 12px',
          borderRadius: 'var(--r-row, 11px)',
          border: ROW_BORDER,
          background: ROW_BG,
        }}
      >
        <span
          style={{
            fontFamily: FONT,
            fontWeight: 500,
            fontSize: 13.5,
            color: 'var(--text, #eae5ef)',
          }}
        >
          Projector
        </span>
        <Pill
          on={projectorOn}
          onClick={() =>
            commands.momentary(
              projectorEntry,
              [projectorOn ? 'off' : 'on'],
              `Projector ${projectorOn ? 'off' : 'on'}`,
            )
          }
        >
          {projectorOn ? 'On' : 'Off'}
        </Pill>
      </div>
    </div>
  );
}

export default AvCluster;
