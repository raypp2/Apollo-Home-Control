// Apollo v2 dashboard -- shared −/temp°/+ stepper used by both the panel
// CLIMATE cluster (compact) and the drill-in (larger). Pure presentational:
// the caller owns the value and the step callback, this just renders and
// clamps the button-disabled state at the 60-80 range the AC module accepts.

const FONT = "'Outfit', system-ui, sans-serif";

const MIN = 60;
const MAX = 80;

/**
 * @param {object} props
 * @param {number} props.value - current setpoint, °F
 * @param {(next:number) => void} props.onStep - called with the new value
 * @param {boolean} [props.disabled] - true when the AC is off; dims + blocks taps
 * @param {number} [props.size] - font size for the temperature readout (default 20)
 */
function SetpointStepper({ value, onStep, disabled = false, size = 20 }) {
  const canDown = !disabled && value > MIN;
  const canUp = !disabled && value < MAX;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        opacity: disabled ? 0.4 : 1,
      }}
    >
      <button
        type="button"
        disabled={!canDown}
        onClick={() => onStep(value - 1)}
        aria-label="Lower setpoint"
        style={stepperButtonStyle(canDown)}
      >
        &minus;
      </button>
      <span
        style={{
          fontFamily: FONT,
          fontWeight: 600,
          fontSize: size,
          minWidth: size * 1.8,
          textAlign: 'center',
        }}
      >
        {value}&deg;
      </span>
      <button
        type="button"
        disabled={!canUp}
        onClick={() => onStep(value + 1)}
        aria-label="Raise setpoint"
        style={stepperButtonStyle(canUp)}
      >
        +
      </button>
    </div>
  );
}

function stepperButtonStyle(active) {
  return {
    width: 30,
    height: 30,
    borderRadius: 'var(--r-btn, 9px)',
    border: '1px solid rgba(234, 229, 239, 0.15)',
    background: 'rgba(234, 229, 239, 0.05)',
    color: 'var(--text, #eae5ef)',
    fontFamily: FONT,
    fontWeight: 500,
    fontSize: 16,
    lineHeight: 1,
    cursor: active ? 'pointer' : 'default',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  };
}

export default SetpointStepper;
export { SetpointStepper, MIN as SETPOINT_MIN, MAX as SETPOINT_MAX };
