// Apollo v2 dashboard -- color swatch picker for color-capable Hue lights
// (kind 'color', see commands.kindOf). Rendered by DeviceRow as a drill-in
// revealed by its '>' toggle; not a standalone row.

import { commands } from '../state/index.js';

const SWATCH_SIZE = 28;
const SELECTED_RING = '#eae5ef';

function normalize(hex) {
  return hex ? hex.replace('#', '').toLowerCase() : null;
}

/**
 * @param {object} props
 * @param {object} props.entry - the store device entry to command
 * @param {string|null} props.color - the light's current view.color (may be
 *   null if the light has never reported/been set)
 */
function ColorSwatches({ entry, color }) {
  const current = normalize(color);

  return (
    <div
      style={{
        display: 'flex',
        gap: 10,
        padding: '2px 12px 4px',
        flexWrap: 'wrap',
      }}
    >
      {commands.COLOR_CHOICES.map((hex) => {
        const selected = current === normalize(hex);
        return (
          <button
            key={hex}
            type="button"
            aria-label={`Set color ${hex}`}
            aria-pressed={selected}
            onClick={(event) => {
              event.stopPropagation();
              commands.setColor(entry, hex);
            }}
            style={{
              width: SWATCH_SIZE,
              height: SWATCH_SIZE,
              flexShrink: 0,
              borderRadius: '50%',
              border: '1px solid rgba(20, 17, 26, 0.35)',
              outline: selected ? `2px solid ${SELECTED_RING}` : 'none',
              outlineOffset: 2,
              background: hex,
              cursor: 'pointer',
              padding: 0,
            }}
          />
        );
      })}
    </div>
  );
}

export default ColorSwatches;
