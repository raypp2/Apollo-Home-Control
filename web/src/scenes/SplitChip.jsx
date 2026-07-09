// Apollo v2 dashboard -- segmented On/Off chip (increment 6).
//
// The default scene bar's "All Lights" entry used to be a single toggle
// pill, but the two things Ray actually reaches for are the explicit ends --
// everything on, everything off -- not a toggle whose direction depends on
// guessing the current state. This renders one chip: a label plus two mini
// buttons that each dispatch an explicit `commands.setScene(entry, on)`
// rather than flipping off the ambient `entry.active` flag.

/**
 * @param {object} props
 * @param {string} props.label
 * @param {object} props.entry - a store.scenes record ({id, title, active})
 * @param {() => void} props.onOn
 * @param {() => void} props.onOff
 */
export function SplitChip({ label, entry, onOn, onOff }) {
  const isOn = Boolean(entry && entry.active);

  return (
    <div class="split-chip">
      <span class="split-chip-label">{label}</span>
      <button
        type="button"
        class={`split-chip-btn split-chip-on${isOn ? ' is-active' : ''}`}
        aria-pressed={isOn}
        onClick={onOn}
      >
        On
      </button>
      <button
        type="button"
        class={`split-chip-btn split-chip-off${!isOn ? ' is-active' : ''}`}
        aria-pressed={!isOn}
        onClick={onOff}
      >
        Off
      </button>
    </div>
  );
}

export default SplitChip;
