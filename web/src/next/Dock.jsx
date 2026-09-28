// Apollo v2 dashboard -- mobile "next" layout: the Dock, a pinned-bottom card
// holding the two most-used controls (receiver volume/source, AC setpoint).
// The shell (NextApp.jsx) renders this unconditionally at the bottom of the
// screen; it hides itself entirely when neither the receiver nor the AC
// exists in this install (see the final `if` below).
//
// No power buttons live here -- receiver power lives in MediaTab, AC power
// (and mode/fan/override) lives in ClimateTab. This is deliberately just the
// two controls someone reaches for constantly: volume/source, and setpoint.

import { useEffect, useState } from 'preact/hooks';
import { store, commands } from '../state/index.js';
import {
  INPUT_NUMBER_TO_LABEL,
  SCENE_ID_TO_INPUT_NUMBER,
  PENDING_TIMEOUT_MS,
} from '../av/sources.js';
import { SETPOINT_MIN, SETPOINT_MAX } from '../climate/SetpointStepper.jsx';
import VolumeControl from './VolumeControl.jsx';
import './dock.css';

function SpeakerIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 9v6h4l5 4V5L8 9H4Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path
        d="M16.5 8.5a5 5 0 0 1 0 7"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <path
        d="M19 6a8.5 8.5 0 0 1 0 12"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        opacity="0.6"
      />
    </svg>
  );
}

function SnowflakeIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <g stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
        <path d="M12 2v20" />
        <path d="M4 6l16 12" />
        <path d="M20 6 4 18" />
        <path d="M12 2 9.5 4.5M12 2l2.5 2.5M12 22l-2.5-2.5M12 22l2.5-2.5" />
      </g>
    </svg>
  );
}

/**
 * The receiver source picker popover, anchored above the "Choose source"
 * button. Fires the same avInputScene command AvCluster's off-state picker
 * uses (powers the receiver on and selects in one command), with a quiet
 * "Starting…" pending state on the tapped item until the live input number
 * confirms it, or PENDING_TIMEOUT_MS elapses.
 */
function SourcePopover({ inputScenes, onClose }) {
  const [pendingId, setPendingId] = useState(null);

  useEffect(() => {
    if (!pendingId) return undefined;
    const timer = setTimeout(() => setPendingId(null), PENDING_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [pendingId]);

  function select(scene) {
    commands.avInputScene(scene.id, scene.label);
    setPendingId(scene.id);
    // The dock doesn't stay open watching for confirmation the way
    // AvCluster's inline picker does -- close it once the tap registers so
    // the dock returns to its normal volume-bar layout as soon as the
    // receiver reports on (a re-render then swaps this popover out for the
    // ON-state volume bar automatically).
    setTimeout(onClose, 350);
  }

  return (
    <>
      <div className="next-source-backdrop" onClick={onClose} />
      <div className="next-source-popover">
        {inputScenes.map((scene) => (
          <button
            key={scene.id}
            type="button"
            className={`next-source-item${pendingId === scene.id ? ' next-pending' : ''}`}
            onClick={() => select(scene)}
          >
            <span>{scene.label}</span>
            {pendingId === scene.id && <span>Starting…</span>}
          </button>
        ))}
      </div>
    </>
  );
}

function ReceiverSlot({ receiverEntry }) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const live = (receiverEntry && receiverEntry.live) || {};
  const on = live.power === 'ON';

  if (!on) {
    const inputScenes = store.deviceScenes.value.map((s) => ({ id: s.id, label: s.title }));
    return (
      <div className="next-dock-slot next-dock-slot--receiver" style={{ position: 'relative' }}>
        <button
          type="button"
          className="next-dock-sources-btn"
          onClick={() => setPickerOpen((o) => !o)}
        >
          <SpeakerIcon />
          Sources
        </button>
        {pickerOpen && (
          <SourcePopover inputScenes={inputScenes} onClose={() => setPickerOpen(false)} />
        )}
      </div>
    );
  }

  const sourceLabel = INPUT_NUMBER_TO_LABEL[live.input] || null;

  return (
    <div className="next-dock-slot next-dock-slot--receiver">
      <VolumeControl
        db={typeof live.volume === 'number' ? live.volume : -80}
        muted={Boolean(live.mute)}
        sourceLabel={sourceLabel}
        height={44}
        onChange={(db) => commands.avVolume(receiverEntry, db)}
      />
    </div>
  );
}

function AcSlot({ acEntry }) {
  const live = acEntry.live || {};
  const on = live.power === 'ON';
  const mode = live.mode || 'COOL';
  const setpoint = typeof live.setpoint === 'number' ? live.setpoint : 72;

  if (!on) {
    return (
      <div className="next-dock-slot next-dock-slot--ac">
        <button
          type="button"
          className="next-dock-ac-btn"
          onClick={() => commands.climatePower(acEntry, true)}
        >
          <span className="next-dock-ac-btn-icon-row">
            <SnowflakeIcon />
            <span className="next-dock-ac-btn-label">AC</span>
          </span>
          <span className="next-dock-ac-btn-setpoint">{setpoint}°</span>
        </button>
      </div>
    );
  }

  const canDown = setpoint > SETPOINT_MIN;
  const canUp = setpoint < SETPOINT_MAX;

  return (
    <div className="next-dock-slot next-dock-slot--ac">
      <div className="next-dock-ac-stepper">
        <button
          type="button"
          className="next-dock-ac-step-btn"
          aria-label="Lower AC setpoint"
          disabled={!canDown}
          onClick={() => commands.climateSetpoint(acEntry, setpoint - 1)}
        >
          &minus;
        </button>
        <div className="next-dock-ac-readout">
          <span className="next-dock-ac-temp">{setpoint}°</span>
          <span className="next-dock-ac-mode">{mode}</span>
        </div>
        <button
          type="button"
          className="next-dock-ac-step-btn"
          aria-label="Raise AC setpoint"
          disabled={!canUp}
          onClick={() => commands.climateSetpoint(acEntry, setpoint + 1)}
        >
          +
        </button>
      </div>
    </div>
  );
}

/**
 * @returns {import('preact').VNode|null}
 */
function Dock() {
  const devices = [...store.devices.value.values()];
  const acEntry = devices.find((e) => e.isAC || (e.alexa && e.alexa.isAC)) || null;
  const receiverEntry = devices.find((e) => e.speaker) || null;

  if (!acEntry && !receiverEntry) return null;

  return (
    <div className="next-dock">
      {receiverEntry && <ReceiverSlot receiverEntry={receiverEntry} />}
      {receiverEntry && acEntry && <div className="next-dock-divider" />}
      {acEntry && <AcSlot acEntry={acEntry} />}
    </div>
  );
}

export default Dock;
