// Apollo v2 dashboard -- Accent row (increment 3): consolidates the 6 living
// room DMX fixture lights (ids ceiling, webcam-back, deer, end-table,
// coffee-table, mirrorball-subtle; all type 'dmxFixture') into one row with
// 3 quick-pick preset pills for the common ones, plus a drill-in (see
// AccentDrillIn.jsx) for the honest full-fixture/scene view.

import { commands } from '../state/index.js';

const FONT = "'Outfit', system-ui, sans-serif";
const ROW_BORDER = '1px solid rgba(234, 229, 239, 0.11)';
const ROW_BG = 'rgba(234, 229, 239, 0.03)';
const OFF_DOT = 'rgba(234, 229, 239, 0.18)';
const AMBER = 'var(--amber, #f2a65e)';

// Preset pill -> dmxFixture id. Only 3 of the 6 fixtures get a quick pick;
// the rest live in the drill-in (Task 3).
const PRESETS = [
  { id: 'ceiling', label: 'Ceiling' },
  { id: 'deer', label: 'Deer' },
  { id: 'mirrorball-subtle', label: 'Mirror Ball' },
];

/**
 * @param {object} props
 * @param {Array<object>} props.entries - all dmxFixture entries in the room
 * @param {() => void} props.onShowControls - opens the Accent drill-in
 */
function AccentRow({ entries, onShowControls }) {
  const entriesById = new Map(entries.map((entry) => [entry.id, entry]));

  const presetViews = PRESETS.map((preset) => {
    const entry = entriesById.get(preset.id);
    const on = Boolean(entry && commands.deviceView(entry).on);
    return { ...preset, entry, on };
  });

  const activePreset = presetViews.find((p) => p.on);
  const anyOn = entries.some((entry) => commands.deviceView(entry).on);

  // Tapping the row body (not a pill) turns off whatever's currently on --
  // DMX has no dimming-to-zero concept here, just on/off per fixture.
  function handleBodyClick() {
    entries.forEach((entry) => {
      if (commands.deviceView(entry).on) commands.toggle(entry);
    });
  }

  return (
    <div
      onClick={handleBodyClick}
      style={{
        borderRadius: 'var(--r-row, 11px)',
        border: ROW_BORDER,
        background: ROW_BG,
        padding: '9px 10px 10px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        cursor: 'pointer',
        userSelect: 'none',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span
          aria-hidden="true"
          style={{
            width: 7,
            height: 7,
            borderRadius: '50%',
            flexShrink: 0,
            background: anyOn ? AMBER : OFF_DOT,
            boxShadow: anyOn ? `0 0 5px 1px ${AMBER}` : 'none',
          }}
        />
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
          <span
            style={{
              fontFamily: FONT,
              fontWeight: 500,
              fontSize: 13.5,
              color: 'var(--text, #eae5ef)',
            }}
          >
            Accent
          </span>
          <span
            style={{
              fontFamily: FONT,
              fontWeight: 300,
              fontSize: 10.5,
              color: 'rgba(234, 229, 239, 0.4)',
            }}
          >
            {activePreset ? `preset · ${activePreset.label}` : 'pick a scene to turn on'}
          </span>
        </div>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onShowControls();
          }}
          style={{
            background: 'transparent',
            border: 'none',
            color: 'var(--accent, #a688e8)',
            fontFamily: FONT,
            fontWeight: 500,
            fontSize: 11,
            cursor: 'pointer',
            flexShrink: 0,
            whiteSpace: 'nowrap',
            padding: '4px 0 4px 8px',
          }}
        >
          show controls &rsaquo;
        </button>
      </div>

      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
        {presetViews.map((preset) => (
          <button
            key={preset.id}
            type="button"
            disabled={!preset.entry}
            onClick={(event) => {
              event.stopPropagation();
              if (preset.entry) commands.toggle(preset.entry);
            }}
            style={{
              padding: '5px 12px',
              borderRadius: 'var(--r-pill, 999px)',
              border: preset.on
                ? '1px solid var(--amber, #f2a65e)'
                : '1px solid rgba(234, 229, 239, 0.15)',
              background: preset.on ? 'rgba(242, 166, 94, 0.18)' : 'rgba(234, 229, 239, 0.05)',
              color: preset.on
                ? 'var(--amber-text, #f2c79a)'
                : 'var(--text-secondary, rgba(234, 229, 239, 0.55))',
              fontFamily: FONT,
              fontWeight: 400,
              fontSize: 11,
              cursor: preset.entry ? 'pointer' : 'default',
              opacity: preset.entry ? 1 : 0.4,
              whiteSpace: 'nowrap',
            }}
          >
            {preset.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export default AccentRow;
