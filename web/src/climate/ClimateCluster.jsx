// Apollo v2 dashboard -- CLIMATE cluster (increment 5): slim row in the
// pinned command-panel footer for the living room AC. `livingRoomAC` is a
// one-way IR blaster with no readback, so everything rendered here is
// Apollo's assumed shadow state, not a live sensor reading -- the honest
// "assumed / no readback" explanation lives in ClimateDrillIn.jsx (behind
// "All controls ›") along with mode/fan and the manual override form, so the
// slim strip itself stays down to one compact control row.

import { useState } from 'preact/hooks';
import { commands } from '../state/index.js';
import ClimateDrillIn from './ClimateDrillIn.jsx';
import SetpointStepper from './SetpointStepper.jsx';

const FONT = "'Outfit', system-ui, sans-serif";

/**
 * @param {object} props
 * @param {object} props.acEntry - the livingRoomAC store entry (module 'AC')
 */
function ClimateCluster({ acEntry }) {
  const [drillInOpen, setDrillInOpen] = useState(false);

  if (!acEntry) return null;

  const live = acEntry.live || {};
  const on = live.power === 'ON';
  const mode = live.mode || 'COOL';
  const setpoint = typeof live.setpoint === 'number' ? live.setpoint : 72;

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
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span
          style={{
            fontFamily: FONT,
            fontWeight: 500,
            fontSize: 11,
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            color: 'rgba(234, 229, 239, 0.45)',
            flex: 1,
          }}
        >
          Climate
        </span>
        <button
          type="button"
          onClick={() => setDrillInOpen(true)}
          style={{
            background: 'transparent',
            border: 'none',
            color: 'var(--accent, #a688e8)',
            fontFamily: FONT,
            fontWeight: 500,
            fontSize: 11,
            cursor: 'pointer',
            padding: '4px 0',
            whiteSpace: 'nowrap',
          }}
        >
          All controls &rsaquo;
        </button>
      </div>

      <div
        style={{
          borderRadius: 'var(--r-row, 11px)',
          border: '1px solid rgba(234, 229, 239, 0.11)',
          background: 'rgba(234, 229, 239, 0.03)',
          padding: '10px 12px',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
        }}
      >
        {/* Label is the ACTION this tap performs, not the current state --
            "On" while off (tap to turn on), "Off" while running (tap to turn
            off). Highlight/border still track the actual `on` state. */}
        <button
          type="button"
          onClick={() => commands.climatePower(acEntry, !on)}
          style={{
            padding: '6px 14px',
            borderRadius: 'var(--r-pill, 999px)',
            border: on
              ? '1px solid var(--accent, #a688e8)'
              : '1px solid rgba(234, 229, 239, 0.15)',
            background: on ? 'var(--accent-fill, rgba(166, 136, 232, 0.16))' : 'rgba(234, 229, 239, 0.05)',
            color: on ? 'var(--accent, #a688e8)' : 'var(--text-secondary, rgba(234, 229, 239, 0.55))',
            fontFamily: FONT,
            fontWeight: 500,
            fontSize: 12,
            cursor: 'pointer',
            flexShrink: 0,
          }}
        >
          {on ? 'Off' : 'On'}
        </button>

        <div style={{ flex: 1, display: 'flex', justifyContent: 'center' }}>
          <SetpointStepper
            value={setpoint}
            disabled={!on}
            onStep={(next) => commands.climateSetpoint(acEntry, next)}
          />
        </div>

        <span
          style={{
            fontFamily: FONT,
            fontWeight: 500,
            fontSize: 10.5,
            letterSpacing: '0.04em',
            padding: '4px 9px',
            borderRadius: 'var(--r-pill, 999px)',
            border: '1px solid rgba(234, 229, 239, 0.15)',
            color: 'var(--text-secondary, rgba(234, 229, 239, 0.55))',
            opacity: on ? 1 : 0.4,
            flexShrink: 0,
          }}
        >
          {mode}
        </span>
      </div>

      {drillInOpen && (
        <ClimateDrillIn acEntry={acEntry} onBack={() => setDrillInOpen(false)} />
      )}
    </div>
  );
}

export default ClimateCluster;
export { ClimateCluster };
