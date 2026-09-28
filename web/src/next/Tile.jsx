// Apollo "next" preview layout -- one light/group/accent tile in the Lights
// tab grid (see LightsTab.jsx). Deliberately dumb: it takes a fully-computed
// view model (name/value/on/level/color/hasMore + callbacks) rather than a
// raw device entry, so it works identically for a plain light, a folded
// DEVICE_GROUPS group, and the folded Accent (DMX) tile -- LightsTab.jsx owns
// translating each of those into this shape via commands.deviceView etc.
//
// Interaction:
//  - A plain quick tap toggles (onTap).
//  - A tap on the small "›" corner affordance always opens the TileSheet
//    (onOpenSheet) -- only rendered when `hasMore` is true (a plain switch
//    has nothing more to show).
//  - Non-dimmable tiles (switch lights, groups, Accent): long-press (~450ms,
//    cancelled if the pointer travels more than MOVE_CANCEL_PX so a scroll
//    gesture isn't hijacked) opens the sheet, same as the corner button.
//  - Dimmable tiles (a single dim/color light, `dimmable` prop): press and
//    hold (~350ms, cancelled by the same scroll dead zone) lifts the tile
//    into "dim mode", after which a vertical drag sets brightness directly
//    (up = brighter, down = dimmer) -- see useDimPressGesture below. A hold
//    that's released without a meaningful slide still opens the sheet, so
//    hold-and-release reaches the detail view exactly like a non-dimmable
//    tile.
//
// Two real <button> elements (body + corner), not a nested-button div soup.

import { useEffect, useRef, useState } from 'preact/hooks';

const LONG_PRESS_MS = 450;
const MOVE_CANCEL_PX = 8;

// Dim gesture tuning (see useDimPressGesture).
const HOLD_MS = 350;
const SCROLL_CANCEL_PX = 8;
const TAP_VS_SHEET_PX = 6;
const PCT_PER_PX = 0.5; // 1% per 2px of vertical movement
const LIVE_THROTTLE_MS = 100; // matches useDragGesture's streamed-commit rate

function clampLevel(v) {
  return Math.max(0, Math.min(100, Math.round(v)));
}

/** Tap-vs-long-press pointer gesture, cancelled by movement past the dead
 * zone (so a vertical scroll on the tab content isn't swallowed as a press).
 * `onLongPress` may be null (switch tiles with nothing to drill into). Used
 * for every non-dimmable tile. */
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
    // Once dimming, a touch is driven by the touchmove listener below (the
    // pointer stream may be cancelled by the browser's pan handling).
    const s = stateRef.current;
    if (s && s.dimStarted && event.pointerType === 'touch') return;
    handleMove(event.clientX, event.clientY);
  }

  function handleMove(clientX, clientY) {
    const s = stateRef.current;
    if (!s) return;
    const dx = clientX - s.startX;
    const dy = clientY - s.startY;
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
 * Press-and-hold-then-slide gesture for a dimmable tile.
 *
 * Phase 1 (pre-hold): pointerdown arms a HOLD_MS timer. Movement past
 * SCROLL_CANCEL_PX before the timer fires cancels it and drops the gesture
 * entirely -- nothing is prevented, so the browser's own vertical scroll
 * takes over exactly as if this tile weren't here.
 *
 * Phase 2 (dim mode): the timer firing lifts the tile (`dimMode` true) and,
 * from that instant, blocks page scroll for the rest of the touch via a
 * non-passive `touchmove` listener that calls preventDefault() -- CSS
 * `touch-action` alone can't retract a scroll permission mid-gesture once
 * the browser has already committed to panning, so this has to be manual.
 * Vertical drag from here maps 1:1 to brightness (relative to the level at
 * hold-start) and streams through `onDimPreview` every move, throttled
 * through `onDimCommit` too when `commitMode === 'live'` (mirrors
 * useDragGesture's live-vs-release split).
 *
 * Release: if dim mode was entered but the finger barely moved (<
 * TAP_VS_SHEET_PX total), nothing was really "set" -- open the sheet instead
 * of committing, so hold-and-release still reaches the detail view. Anywhere
 * past that threshold commits the dragged level.
 */
function useDimPressGesture({ level, commitMode, onDimPreview, onDimCommit, onOpenSheet, onTap }) {
  const stateRef = useRef(null);
  const [dimMode, setDimMode] = useState(false);
  const [dimLevel, setDimLevel] = useState(0);

  const elementRef = useRef(null);

  function onPointerDown(event) {
    const element = event.currentTarget;
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    const startLevel = clampLevel(level);
    const timer = setTimeout(() => {
      const s = stateRef.current;
      if (!s) return;
      s.dimStarted = true;
      s.moved = 0;
      s.lastVal = startLevel;
      s.lastCommitSend = 0;
      if (element.setPointerCapture) {
        try {
          element.setPointerCapture(pointerId);
        } catch {
          // Pointer may already be released/invalid -- dim mode still works
          // without capture, just without the guaranteed event delivery.
        }
      }
      setDimMode(true);
      setDimLevel(startLevel);
    }, HOLD_MS);
    stateRef.current = {
      startX, startY, startLevel, timer, element, pointerId,
      dimStarted: false, moved: 0, lastVal: startLevel, lastCommitSend: 0,
    };
  }

  function onPointerMove(event) {
    const s = stateRef.current;
    if (!s) return;
    const dx = event.clientX - s.startX;
    const dy = event.clientY - s.startY;
    if (!s.dimStarted) {
      if (Math.sqrt(dx * dx + dy * dy) > SCROLL_CANCEL_PX) {
        clearTimeout(s.timer);
        stateRef.current = null; // let the browser's native scroll take over
      }
      return;
    }
    s.moved = Math.max(s.moved, Math.sqrt(dx * dx + dy * dy));
    const val = clampLevel(s.startLevel - dy * PCT_PER_PX);
    s.lastVal = val;
    setDimLevel(val);
    onDimPreview(val);
    if (commitMode === 'live') {
      const now = Date.now();
      if (now - s.lastCommitSend >= LIVE_THROTTLE_MS) {
        s.lastCommitSend = now;
        onDimCommit(val);
      }
    }
  }

  function finish() {
    const s = stateRef.current;
    stateRef.current = null;
    if (!s) return;
    clearTimeout(s.timer);
    if (!s.dimStarted) {
      // Hold never fired: a plain quick tap.
      onTap();
      return;
    }
    setDimMode(false);
    if (s.moved < TAP_VS_SHEET_PX) {
      // Held and released without really sliding -- same outcome as a
      // non-dimmable tile's long-press: open the detail sheet.
      onOpenSheet();
      return;
    }
    onDimCommit(s.lastVal);
  }

  function onPointerUp() {
    finish();
  }

  function onPointerCancel(event) {
    const s = stateRef.current;
    // With touch-action: pan-y the browser may cancel the pointer when the
    // finger starts moving vertically, even mid-dim. The touch listeners
    // below keep the gesture alive and finish it on touchend instead.
    if (s && s.dimStarted && event && event.pointerType === 'touch') return;
    if (s && !s.dimStarted) {
      // Cancelled before dim mode even started (e.g. the OS took the
      // gesture) -- just reset, nothing was previewed or committed.
      clearTimeout(s.timer);
      stateRef.current = null;
      return;
    }
    finish();
  }

  // Registered once for the element's lifetime, NON-passive, so it exists
  // before the touch starts: that's what lets preventDefault() actually stop
  // iOS Safari (and Chrome) from scrolling once the hold has fired. Before
  // the hold fires it does nothing, so normal scrolling is untouched.
  useEffect(() => {
    const el = elementRef.current;
    if (!el) return undefined;
    const onTouchMove = (e) => {
      const s = stateRef.current;
      if (!s || !s.dimStarted) return;
      e.preventDefault();
      const t = e.touches[0];
      if (t) handleMove(t.clientX, t.clientY);
    };
    const onTouchEnd = () => {
      const s = stateRef.current;
      if (s && s.dimStarted) finish();
    };
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd);
    el.addEventListener('touchcancel', onTouchEnd);
    return () => {
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('touchcancel', onTouchEnd);
    };
  });

  return { elementRef, dimMode, dimLevel, onPointerDown, onPointerMove, onPointerUp, onPointerCancel };
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
 * @param {boolean} [props.dimmable] - single dim/color light: gets the
 *   press-and-hold-then-slide gesture instead of a plain long-press
 * @param {'live'|'release'} [props.commitMode] - only meaningful with
 *   `dimmable`, see commands.commitMode
 * @param {(val:number)=>void} [props.onDimPreview] - only with `dimmable`
 * @param {(val:number)=>void} [props.onDimCommit] - only with `dimmable`
 * @param {() => void} props.onTap
 * @param {() => void} props.onOpenSheet
 */
function Tile({
  name, value, on, level, color, dimmed, pending, hasMore,
  dimmable, commitMode, onDimPreview, onDimCommit, onTap, onOpenSheet,
}) {
  // Both gesture hooks are always called (rules of hooks); only one is ever
  // wired to the DOM below, based on `dimmable`, so the other's timers never
  // start.
  const pressGesture = usePressGesture(onTap, hasMore && !dimmable ? onOpenSheet : null);
  const dimGesture = useDimPressGesture({
    level: level || 0,
    commitMode,
    onDimPreview: onDimPreview || (() => {}),
    onDimCommit: onDimCommit || (() => {}),
    onOpenSheet,
    onTap,
  });
  const gesture = dimmable ? dimGesture : pressGesture;
  const inDimMode = dimmable && dimGesture.dimMode;

  const fillPct = typeof level === 'number' ? Math.max(0, Math.min(100, level)) : (on ? 100 : 0);

  return (
    <div class={`next-tile${dimmed ? ' is-dimmed' : ''}${pending ? ' is-pending' : ''}${inDimMode ? ' is-dim-mode' : ''}`}>
      <button
        type="button"
        class="next-tile-body"
        ref={dimmable ? dimGesture.elementRef : undefined}
        onPointerDown={gesture.onPointerDown}
        onPointerMove={gesture.onPointerMove}
        onPointerUp={gesture.onPointerUp}
        onPointerCancel={gesture.onPointerCancel}
        // Pointer events drive tap/long-press/dim; this only catches keyboard
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
        {inDimMode && (
          <span aria-hidden="true" class="next-tile-readout">{dimGesture.dimLevel}%</span>
        )}
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
