// Apollo v2 dashboard -- Climate drill-in (increment 4): full mode/fan/
// setpoint controls for the living room AC, plus the recalibration
// ("override") form.
//
// livingRoomAC is a one-way IR blaster -- Apollo has no readback from the
// unit, only a shadow of the last command it believes it sent. Every value
// in this drill-in (including the "assumed state" card) is that guess, never
// a live sensor reading. The override section lets the honest owner correct
// the shadow directly (e.g. after using the physical remote) without
// re-sending IR.

import { useState } from 'preact/hooks';
import { commands } from '../state/index.js';
import { DrillInShell, SegmentedGroup } from '../panel/DrillInShell.jsx';
import SetpointStepper, { SETPOINT_MIN, SETPOINT_MAX } from './SetpointStepper.jsx';

const FONT = "'Outfit', system-ui, sans-serif";

const MODES = ['COOL', 'ECO'];
const FANS = ['auto', 'low', 'med', 'high'];

function sectionLabelStyle() {
  return {
    fontFamily: FONT,
    fontWeight: 500,
    fontSize: 11,
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    color: 'var(--text-tertiary, rgba(234, 229, 239, 0.32))',
    marginBottom: 8,
  };
}

/**
 * @param {object} props
 * @param {object} props.acEntry - the livingRoomAC store entry (module 'AC')
 * @param {() => void} props.onBack
 */
function ClimateDrillIn({ acEntry, onBack }) {
  const live = acEntry.live || {};
  const on = live.power === 'ON';
  const mode = live.mode || 'COOL';
  const fan = live.fan || 'auto';
  const setpoint = typeof live.setpoint === 'number' ? live.setpoint : 72;

  // Override draft: a local, editable copy of the assumed state. Seeded from
  // the current shadow so an untouched field re-applies its own value
  // (harmless) rather than some stale default. Reset only happens on
  // remount, which is fine -- the drill-in unmounts every time it closes.
  const [draftPower, setDraftPower] = useState(on);
  const [draftMode, setDraftMode] = useState(mode);
  const [draftFan, setDraftFan] = useState(fan);
  const [draftSetpoint, setDraftSetpoint] = useState(setpoint);
  const [applied, setApplied] = useState(false);

  function applyOverride() {
    commands.climateOverride(acEntry, {
      power: draftPower ? 'ON' : 'OFF',
      mode: draftMode,
      fan: draftFan,
      setpoint: draftSetpoint,
    });
    setApplied(true);
    setTimeout(() => setApplied(false), 2000);
  }

  return (
    <DrillInShell title="Climate" onBack={onBack}>
      <div
        style={{
          fontFamily: FONT,
          fontWeight: 300,
          fontSize: 11.5,
          color: 'var(--text-tertiary, rgba(234, 229, 239, 0.32))',
          marginTop: -8,
        }}
      >
        assumed state &middot; no sensor readback
      </div>

      <SegmentedGroup
        label="Power"
        items={[
          { id: 'on', title: 'On', on, onToggle: () => commands.climatePower(acEntry, true) },
          { id: 'off', title: 'Off', on: !on, onToggle: () => commands.climatePower(acEntry, false) },
        ]}
      />

      <SegmentedGroup
        label="Mode"
        items={MODES.map((m) => ({
          id: m,
          title: m === 'COOL' ? 'Cool' : 'Eco',
          on: mode === m,
          onToggle: () => commands.climateMode(acEntry, m),
        }))}
      />

      <SegmentedGroup
        label="Fan"
        items={FANS.map((f) => ({
          id: f,
          title: f[0].toUpperCase() + f.slice(1),
          on: fan === f,
          onToggle: () => commands.climateFan(acEntry, f),
        }))}
      />

      <div>
        <div style={sectionLabelStyle()}>Setpoint</div>
        <SetpointStepper
          value={setpoint}
          disabled={!on}
          size={26}
          onStep={(next) => commands.climateSetpoint(acEntry, next)}
        />
      </div>

      {/* --- override / recalibration ------------------------------------ */}
      <div
        style={{
          marginTop: 4,
          paddingTop: 16,
          borderTop: '1px solid var(--hairline, rgba(234, 229, 239, 0.1))',
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}
      >
        <div>
          <div
            style={{
              fontFamily: FONT,
              fontWeight: 500,
              fontSize: 12.5,
              color: 'var(--amber-text, #f2c79a)',
              marginBottom: 4,
            }}
          >
            Correct assumed state (no command sent)
          </div>
          <div
            style={{
              fontFamily: FONT,
              fontWeight: 300,
              fontSize: 11,
              lineHeight: 1.5,
              color: 'var(--text-tertiary, rgba(234, 229, 239, 0.32))',
            }}
          >
            The AC has no sensor feedback. If it drifted from what Apollo
            assumes, set the real values here -- this updates Apollo's
            assumption without sending IR.
          </div>
        </div>

        <SegmentedGroup
          label="Power (override)"
          items={[
            { id: 'on', title: 'On', on: draftPower, onToggle: () => setDraftPower(true) },
            { id: 'off', title: 'Off', on: !draftPower, onToggle: () => setDraftPower(false) },
          ]}
        />

        <SegmentedGroup
          label="Mode (override)"
          items={MODES.map((m) => ({
            id: m,
            title: m === 'COOL' ? 'Cool' : 'Eco',
            on: draftMode === m,
            onToggle: () => setDraftMode(m),
          }))}
        />

        <SegmentedGroup
          label="Fan (override)"
          items={FANS.map((f) => ({
            id: f,
            title: f[0].toUpperCase() + f.slice(1),
            on: draftFan === f,
            onToggle: () => setDraftFan(f),
          }))}
        />

        <div>
          <div style={sectionLabelStyle()}>Setpoint (override)</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <SetpointStepper
              value={draftSetpoint}
              onStep={(next) => setDraftSetpoint(Math.max(SETPOINT_MIN, Math.min(SETPOINT_MAX, next)))}
            />
            <input
              type="number"
              min={SETPOINT_MIN}
              max={SETPOINT_MAX}
              value={draftSetpoint}
              onInput={(e) => {
                const n = parseInt(e.currentTarget.value, 10);
                if (!Number.isNaN(n)) {
                  setDraftSetpoint(Math.max(SETPOINT_MIN, Math.min(SETPOINT_MAX, n)));
                }
              }}
              style={{
                width: 56,
                padding: '6px 8px',
                borderRadius: 'var(--r-btn, 9px)',
                border: '1px solid rgba(234, 229, 239, 0.15)',
                background: 'rgba(234, 229, 239, 0.05)',
                color: 'var(--text, #eae5ef)',
                fontFamily: FONT,
                fontSize: 13,
              }}
            />
          </div>
        </div>

        <button
          type="button"
          onClick={applyOverride}
          style={{
            marginTop: 4,
            padding: '10px 16px',
            borderRadius: 'var(--r-btn, 9px)',
            border: '1px solid var(--amber, #f2a65e)',
            background: applied ? 'rgba(242, 166, 94, 0.28)' : 'rgba(242, 166, 94, 0.14)',
            color: 'var(--amber-text, #f2c79a)',
            fontFamily: FONT,
            fontWeight: 500,
            fontSize: 13,
            cursor: 'pointer',
          }}
        >
          {applied ? 'Override applied' : 'Apply override'}
        </button>
      </div>

      {/* --- diagnostics --------------------------------------------------- */}
      <div
        style={{
          borderRadius: 'var(--r-row, 11px)',
          border: '1px solid rgba(234, 229, 239, 0.11)',
          background: 'rgba(234, 229, 239, 0.03)',
          padding: '12px 14px',
        }}
      >
        <div
          style={{
            fontFamily: FONT,
            fontWeight: 500,
            fontSize: 11,
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
            color: 'var(--text-tertiary, rgba(234, 229, 239, 0.32))',
            marginBottom: 8,
          }}
        >
          Assumed state
        </div>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'auto 1fr',
            rowGap: 4,
            columnGap: 10,
            fontFamily: "'SF Mono', 'Menlo', monospace",
            fontSize: 12.5,
          }}
        >
          <span style={{ color: 'var(--text-tertiary, rgba(234, 229, 239, 0.32))' }}>power</span>
          <span style={{ color: 'var(--text, #eae5ef)' }}>{on ? 'ON' : 'OFF'} (assumed)</span>
          <span style={{ color: 'var(--text-tertiary, rgba(234, 229, 239, 0.32))' }}>mode</span>
          <span style={{ color: 'var(--text, #eae5ef)' }}>{mode} (assumed)</span>
          <span style={{ color: 'var(--text-tertiary, rgba(234, 229, 239, 0.32))' }}>setpoint</span>
          <span style={{ color: 'var(--text, #eae5ef)' }}>{setpoint}&deg; (assumed)</span>
          <span style={{ color: 'var(--text-tertiary, rgba(234, 229, 239, 0.32))' }}>fan</span>
          <span style={{ color: 'var(--text, #eae5ef)' }}>{fan} (assumed)</span>
        </div>
      </div>
    </DrillInShell>
  );
}

export default ClimateDrillIn;
export { ClimateDrillIn };
