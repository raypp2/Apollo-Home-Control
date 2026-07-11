// Apollo v2 dashboard -- color swatch + wheel picker for color-capable Hue
// lights (kind 'color', see commands.kindOf). Rendered by DeviceRow as a
// drill-in revealed by its '>' toggle; not a standalone row. Offers 6
// quick-pick swatches (universal, shared by every color light -- see
// store.prefs.value.swatches) plus a 7th "custom" swatch that expands an HSV
// wheel for free color choice.
//
// Save flow: the wheel never auto-shows -- only the custom swatch opens it.
// Committing a color on the wheel dispatches it to the light immediately
// (unchanged) AND enters a transient "save?" state: the 6 swatches pulse and
// a hint row appears; the next tap on a swatch REPLACES that slot with the
// committed color and POSTs the full 6-array to /api/prefs/swatches instead
// of dispatching a command. Tapping the custom swatch again, or the hint
// row's ✕, exits "save?" without saving -- normal swatch taps resume.

import { useState } from 'preact/hooks';
import { commands, store } from '../state/index.js';
import { postJson } from '../state/api.js';
import ColorWheel from './ColorWheel.jsx';

const SWATCH_SIZE = 28;
const SELECTED_RING = '#eae5ef';
const SAVE_RING = 'rgba(242, 166, 94, 0.85)';
const FONT = "'Outfit', system-ui, sans-serif";
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

function normalize(hex) {
  return hex ? hex.replace('#', '').toLowerCase() : null;
}

/** True for exactly the 6-slot hex-string shape /api/prefs/swatches accepts. */
function isValidSwatches(arr) {
  return Array.isArray(arr) && arr.length === 6
    && arr.every((s) => typeof s === 'string' && HEX_RE.test(s));
}

/**
 * @param {object} props
 * @param {object} props.entry - the store device entry to command
 * @param {string|null} props.color - the light's current view.color (may be
 *   null if the light has never reported/been set)
 */
function ColorSwatches({ entry, color }) {
  const [wheelOpen, setWheelOpen] = useState(false);
  // Non-null => "save?" mode: the hex just committed on the wheel, waiting
  // for the user to either tap a swatch slot (save) or dismiss (skip).
  const [pendingColor, setPendingColor] = useState(null);

  const current = normalize(color);
  const prefsSwatches = store.prefs.value && store.prefs.value.swatches;
  const swatches = isValidSwatches(prefsSwatches) ? prefsSwatches : commands.COLOR_CHOICES;

  function saveToSlot(index) {
    const next = swatches.slice();
    next[index] = pendingColor;
    setPendingColor(null);
    // Optimistic: update immediately, reconcile with the server's copy below.
    store.prefs.value = { ...store.prefs.value, swatches: next };
    postJson('/api/prefs/swatches', { swatches: next })
      .then((response) => {
        store.prefs.value = response;
      })
      .catch(() => {});
  }

  function handleSwatchTap(hex, index) {
    if (pendingColor) {
      saveToSlot(index);
      return;
    }
    commands.setColor(entry, hex);
  }

  function toggleCustom() {
    setWheelOpen((open) => {
      if (open) setPendingColor(null);
      return !open;
    });
  }

  function handleWheelCommit(hex) {
    commands.setColor(entry, hex);
    setPendingColor(hex);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <style>{`
        @keyframes apollo-swatch-pulse {
          0%, 100% { box-shadow: 0 0 0 0 rgba(242, 166, 94, 0.45); }
          50% { box-shadow: 0 0 0 4px rgba(242, 166, 94, 0.18); }
        }
      `}</style>
      <div
        style={{
          display: 'flex',
          gap: 10,
          padding: '2px 12px 4px',
          flexWrap: 'wrap',
        }}
      >
        {swatches.map((hex, index) => {
          const selected = !pendingColor && current === normalize(hex);
          return (
            <button
              key={`${index}-${hex}`}
              type="button"
              aria-label={pendingColor ? `Save color to swatch ${index + 1}` : `Set color ${hex}`}
              aria-pressed={selected}
              onClick={(event) => {
                event.stopPropagation();
                handleSwatchTap(hex, index);
              }}
              style={{
                width: SWATCH_SIZE,
                height: SWATCH_SIZE,
                flexShrink: 0,
                borderRadius: '50%',
                border: '1px solid rgba(20, 17, 26, 0.35)',
                outline: selected
                  ? `2px solid ${SELECTED_RING}`
                  : pendingColor
                    ? `2px solid ${SAVE_RING}`
                    : 'none',
                outlineOffset: 2,
                background: hex,
                cursor: 'pointer',
                padding: 0,
                animation: pendingColor ? 'apollo-swatch-pulse 1.1s ease-in-out infinite' : 'none',
              }}
            />
          );
        })}
        <button
          type="button"
          aria-expanded={wheelOpen}
          aria-label={wheelOpen ? 'Hide custom color wheel' : 'Custom color'}
          onClick={(event) => {
            event.stopPropagation();
            toggleCustom();
          }}
          style={{
            width: SWATCH_SIZE,
            height: SWATCH_SIZE,
            flexShrink: 0,
            borderRadius: '50%',
            border: wheelOpen ? '2px solid var(--accent, #a688e8)' : '1px solid rgba(20, 17, 26, 0.35)',
            outline: 'none',
            background:
              'conic-gradient(red, yellow, lime, cyan, blue, magenta, red)',
            cursor: 'pointer',
            padding: 0,
          }}
        />
      </div>

      {pendingColor && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '0 12px',
          }}
        >
          <span
            style={{
              flex: 1,
              minWidth: 0,
              fontFamily: FONT,
              fontWeight: 300,
              fontSize: 11,
              lineHeight: 1.4,
              color: 'var(--text-secondary, rgba(234, 229, 239, 0.55))',
            }}
          >
            Save to a swatch — tap one to replace, ✕ to skip
          </span>
          <button
            type="button"
            aria-label="Skip saving"
            onClick={(event) => {
              event.stopPropagation();
              setPendingColor(null);
            }}
            style={{
              flexShrink: 0,
              width: 22,
              height: 22,
              borderRadius: '50%',
              border: '1px solid rgba(234, 229, 239, 0.15)',
              background: 'rgba(234, 229, 239, 0.05)',
              color: 'var(--text-secondary, rgba(234, 229, 239, 0.55))',
              fontFamily: FONT,
              fontSize: 11,
              lineHeight: 1,
              cursor: 'pointer',
              padding: 0,
            }}
          >
            ✕
          </button>
        </div>
      )}

      {wheelOpen && (
        <div style={{ padding: '4px 12px 10px' }}>
          <ColorWheel
            color={color}
            onPreview={(hex) => commands.previewColor(entry, hex)}
            onCommit={handleWheelCommit}
          />
        </div>
      )}
    </div>
  );
}

export default ColorSwatches;
