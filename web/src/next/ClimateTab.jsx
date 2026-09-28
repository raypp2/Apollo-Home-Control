// Apollo v2 dashboard -- mobile "next" layout: full AC controls. Power lives
// here (the Dock never shows a power-off button). livingRoomAC is a one-way
// IR blaster with no readback -- everything here is Apollo's assumed shadow
// state, same honesty note ClimateDrillIn already carries; "All controls ›"
// opens that drill-in as-is for the manual override form.

import { useState } from 'preact/hooks';
import { store, commands } from '../state/index.js';
import { ClimateDrillIn } from '../climate/index.js';
import { SETPOINT_MIN, SETPOINT_MAX } from '../climate/SetpointStepper.jsx';
import './dock.css';

const MODES = ['COOL', 'ECO'];
const FANS = ['auto', 'low', 'med', 'high'];

/**
 * Full climate tab. Finds its own AC entry from the store (same predicate
 * RoomPanel uses: `e.isAC || e.alexa?.isAC`, searched across every device --
 * there is exactly one AC in this install).
 */
function ClimateTab() {
  const [drillInOpen, setDrillInOpen] = useState(false);

  const devices = [...store.devices.value.values()];
  const acEntry = devices.find((e) => e.isAC || (e.alexa && e.alexa.isAC)) || null;

  if (!acEntry) {
    return <div className="next-status-text">No AC configured.</div>;
  }

  const live = acEntry.live || {};
  const on = live.power === 'ON';
  const mode = live.mode || 'COOL';
  const fan = live.fan || 'auto';
  const setpoint = typeof live.setpoint === 'number' ? live.setpoint : 72;
  const canDown = on && setpoint > SETPOINT_MIN;
  const canUp = on && setpoint < SETPOINT_MAX;

  return (
    <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div className="next-power-row">
        <button
          type="button"
          className={`next-power-btn${on ? ' next-on-accent' : ''}`}
          onClick={() => commands.climatePower(acEntry, !on)}
        >
          {on ? 'Turn off' : 'Turn on'}
        </button>
        <span className="next-status-text">AC {on ? 'on' : 'off'}</span>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 16 }}>
        <button
          type="button"
          className="next-climate-step-btn-big"
          aria-label="Lower setpoint"
          disabled={!canDown}
          onClick={() => commands.climateSetpoint(acEntry, setpoint - 1)}
        >
          &minus;
        </button>
        <span className="next-climate-temp-big">{setpoint}&deg;</span>
        <button
          type="button"
          className="next-climate-step-btn-big"
          aria-label="Raise setpoint"
          disabled={!canUp}
          onClick={() => commands.climateSetpoint(acEntry, setpoint + 1)}
        >
          +
        </button>
      </div>

      <div>
        <div className="next-status-text" style={{ marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
          Mode
        </div>
        <div className="next-segmented">
          {MODES.map((m) => (
            <button
              key={m}
              type="button"
              className={`next-segmented-btn${mode === m ? ' next-on-accent' : ''}`}
              onClick={() => commands.climateMode(acEntry, m)}
            >
              {m === 'COOL' ? 'Cool' : 'Eco'}
            </button>
          ))}
        </div>
      </div>

      <div>
        <div className="next-status-text" style={{ marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
          Fan
        </div>
        <div className="next-segmented">
          {FANS.map((f) => (
            <button
              key={f}
              type="button"
              className={`next-segmented-btn${fan === f ? ' next-on-accent' : ''}`}
              onClick={() => commands.climateFan(acEntry, f)}
            >
              {f[0].toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>
      </div>

      <div className="next-status-text">
        Assumed state &middot; one-way IR, no sensor readback.
      </div>

      <button type="button" className="next-all-controls-link" onClick={() => setDrillInOpen(true)}>
        All controls &rsaquo;
      </button>

      {drillInOpen && <ClimateDrillIn acEntry={acEntry} onBack={() => setDrillInOpen(false)} />}
    </div>
  );
}

export default ClimateTab;
