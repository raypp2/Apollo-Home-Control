// Apollo "next" preview layout -- one light/group/accent tile in the Lights
// tab grid (see LightsTab.jsx). Deliberately dumb: it takes a fully-computed
// view model (name/value/on/level/color/hasMore + callbacks) rather than a
// raw device entry, so it works identically for a plain light, a folded
// DEVICE_GROUPS group, and the folded Accent (DMX) tile -- LightsTab.jsx owns
// translating each of those into this shape via commands.deviceView etc.
//
// Interaction: tap toggles (onTap); a long-press (~450ms, cancelled if the
// pointer travels more than MOVE_CANCEL_PX so a scroll gesture isn't
// hijacked) OR a tap on the small "›" corner affordance opens the TileSheet
// bottom sheet (onOpenSheet) -- only rendered when `hasMore` is true (a
// plain switch has nothing more to show). Two real <button> elements (body +
// corner), not a nested-button div soup.

import { useRef } from 'preact/hooks';

const LONG_PRESS_MS = 450;
const MOVE_CANCEL_PX = 8;

/** Tap-vs-long-press pointer gesture, cancelled by movement past the dead
 * zone (so a vertical scroll on the tab content isn't swallowed as a press).
 * `onLongPress` may be null (switch tiles with nothing to drill into). */
function usePressGesture(onTap, onLongPress) {
  const stateRef = useRef(null);

  function clearTimer() {
    if (stateRef.current && stateRef.current.timer) clearTimeout(stateRef.current.timer);
  }

  function onPointerDown(event) {
    const startX = event.clientX;
    const startY = event.clientY;
    const timer = onLongPress
      ? setTimeout(() => {
          if (stateRef.current) {
            stateRef.current.longPressed = true;
            onLongPress();
          }
        }, LONG_PRESS_MS)
      : null;
    stateRef.current = { startX, startY, timer, longPressed: false };
  }

  function onPointerMove(event) {
    const s = stateRef.current;
    if (!s) return;
    const dx = event.clientX - s.startX;
    const dy = event.clientY - s.startY;
    if (Math.sqrt(dx * dx + dy * dy) > MOVE_CANCEL_PX) {
      clearTimer();
      stateRef.current = null;
    }
  }

  function onPointerUp() {
    const s = stateRef.current;
    clearTimer();
    stateRef.current = null;
    if (s && !s.longPressed) onTap();
  }

  function onPointerCancel() {
    clearTimer();
    stateRef.current = null;
  }

  return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel };
}

/**
 * @param {object} props
 * @param {string} props.name
 * @param {string} props.value - "60%" | "On" | "Off" | "2 of 6 on"
 * @param {boolean} props.on
 * @param {number|null} props.level - 0-100 brightness fill, or null (switch)
 * @param {string|null} props.color - live color hex for a color light's dot
 * @param {boolean} [props.dimmed] - stale/unreachable
 * @param {boolean} [props.pending] - optimistic patch not yet confirmed
 * @param {boolean} props.hasMore - whether the sheet/chevron applies
 * @param {() => void} props.onTap
 * @param {() => void} props.onOpenSheet
 */
function Tile({ name, value, on, level, color, dimmed, pending, hasMore, onTap, onOpenSheet }) {
  const gesture = usePressGesture(onTap, hasMore ? onOpenSheet : null);
  const fillPct = typeof level === 'number' ? Math.max(0, Math.min(100, level)) : (on ? 100 : 0);

  return (
    <div class={`next-tile${dimmed ? ' is-dimmed' : ''}${pending ? ' is-pending' : ''}`}>
      <button
        type="button"
        class="next-tile-body"
        onPointerDown={gesture.onPointerDown}
        onPointerMove={gesture.onPointerMove}
        onPointerUp={gesture.onPointerUp}
        onPointerCancel={gesture.onPointerCancel}
        // Pointer events drive tap/long-press; this only catches keyboard
        // activation (Enter/Space report detail 0), which fires no pointer events.
        onClick={(event) => { if (event.detail === 0) onTap(); }}
        onContextMenu={(event) => event.preventDefault()}
      >
        {on && (
          <span aria-hidden="true" class="next-tile-fill" style={{ height: `${fillPct}%` }} />
        )}
        <span class="next-tile-name">{name}</span>
        <span class="next-tile-value">
          {value}
          {color && <span aria-hidden="true" class="next-tile-dot" style={{ background: color }} />}
        </span>
      </button>
      {hasMore && (
        <button
          type="button"
          class="next-tile-more"
          aria-label={`More controls for ${name}`}
          onClick={onOpenSheet}
        >
          &rsaquo;
        </button>
      )}
    </div>
  );
}

export default Tile;
