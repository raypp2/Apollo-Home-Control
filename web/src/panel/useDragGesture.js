// Apollo v2 dashboard -- shared tap-vs-drag pointer gesture for panel rows.
//
// Both DeviceRow (dim) and ShadeRow use the same interaction: a short
// horizontal movement is a tap (toggle), anything past a small dead zone is
// a drag that maps finger/pointer delta-x onto a 0-100 value at a fixed
// px-per-percent rate. What differs between rows is only *what* gets called
// (toggle vs toggleShade, commitLevel vs commitPosition) and, for
// 'live'-commit device types, whether the drag streams commits or just
// previews locally until release -- both handled here via the `commitMode`
// and callback params so DeviceRow/ShadeRow stay thin.

import { useCallback, useRef } from 'preact/hooks';

/** Horizontal movement (px) below which a pointerdown->pointerup is a tap. */
export const DEAD_ZONE_PX = 6;

/** Drag sensitivity: percent of value change per pixel of horizontal drag. */
export const PX_PER_PERCENT = 0.55;

/** Minimum ms between streamed commits while dragging a 'live'-commit row. */
export const LIVE_THROTTLE_MS = 100;

function clamp(v) {
  return Math.max(0, Math.min(100, v));
}

/**
 * @param {object} opts
 * @param {number} opts.startValue - current 0-100 value to drag from (read at
 *   pointerdown time via closure, i.e. pass the latest render's value).
 * @param {'live'|'release'} opts.commitMode - 'live' streams throttled
 *   commits during the drag; 'release' only previews until pointerup.
 * @param {(val:number)=>void} opts.onPreview - local-only display update,
 *   called on every move once dragging has started.
 * @param {(val:number)=>void} opts.onCommit - optimistic + send; called
 *   throttled during a 'live' drag, and always once more on release.
 * @param {()=>void} opts.onTap - called on pointerup if the gesture never
 *   crossed the dead zone (a plain tap/click).
 */
export function useDragGesture({ startValue, commitMode, onPreview, onCommit, onTap }) {
  const dragRef = useRef(null);

  const onPointerDown = useCallback((event) => {
    if (event.currentTarget.setPointerCapture) {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    dragRef.current = {
      startX: event.clientX,
      startValue,
      dragging: false,
      lastSend: 0,
    };
  }, [startValue]);

  const onPointerMove = useCallback((event) => {
    const drag = dragRef.current;
    if (!drag || event.buttons === 0) return;
    const dx = event.clientX - drag.startX;
    if (!drag.dragging) {
      if (Math.abs(dx) <= DEAD_ZONE_PX) return;
      drag.dragging = true;
    }
    const val = clamp(drag.startValue + dx * PX_PER_PERCENT);
    onPreview(val);
    if (commitMode === 'live') {
      const now = Date.now();
      if (now - drag.lastSend >= LIVE_THROTTLE_MS) {
        drag.lastSend = now;
        onCommit(val);
      }
    }
  }, [commitMode, onPreview, onCommit]);

  const endDrag = useCallback((event) => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;
    if (!drag.dragging) {
      onTap();
      return;
    }
    const dx = event.clientX - drag.startX;
    const val = clamp(drag.startValue + dx * PX_PER_PERCENT);
    // Final commit always fires here: the only send for a 'release' row,
    // and a settling resend (usually a near-no-op) for a throttled 'live' row.
    onCommit(val);
  }, [onTap, onCommit]);

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp: endDrag,
    onPointerCancel: endDrag,
  };
}
