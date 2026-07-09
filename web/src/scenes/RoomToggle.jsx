// Apollo v2 dashboard -- room on/off + hold-drag dim toggle (increment 6).
//
// Replaces the room-scoped scene pill (RoomSceneBar) with a single prominent
// control the orchestrator places near the room title: tap toggles the whole
// room's controllable lights on/off (via commands.roomToggle), hold-and-drag
// horizontally dims every dimmable light in the room together (via
// commands.roomDim). The gesture mirrors panel/useDragGesture.js (same dead
// zone + px-per-percent constants) but is reimplemented locally here rather
// than imported, since this directory owns only scenes/ and that hook lives
// under panel/.
//
// Reactivity note: commands.roomAnyOn/roomLevel/roomLights all read
// store.devices.value internally rather than taking a pre-read snapshot.
// Calling them directly in this component's render body still subscribes
// this component to the devices signal -- @preact/signals tracks whichever
// component is currently rendering when a signal's .value getter runs,
// regardless of how many function calls deep that read happens.

import { useCallback, useRef, useState } from 'preact/hooks';
import { store, commands } from '../state/index.js';
import './scenes.css';

/** Horizontal movement (px) below which a pointerdown->pointerup is a tap. */
const DEAD_ZONE_PX = 6;

/** Drag sensitivity: percent of value change per pixel of horizontal drag. */
const PX_PER_PERCENT = 0.55;

function clamp(v) {
  return Math.max(0, Math.min(100, v));
}

/**
 * @param {object} props
 * @param {string} props.roomId
 * @param {string} props.roomLabel
 */
export function RoomToggle({ roomId, roomLabel }) {
  // Subscribes this component to device updates (see reactivity note above).
  void store.devices.value;

  const on = commands.roomAnyOn(roomId);
  const level = commands.roomLevel(roomId);

  const [dragLevel, setDragLevel] = useState(null);
  const dragRef = useRef(null);

  const displayLevel = dragLevel != null ? dragLevel : level;
  const fillPct = on ? Math.max(displayLevel, 4) : 0;

  const onPointerDown = useCallback((event) => {
    if (event.currentTarget.setPointerCapture) {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    dragRef.current = {
      startX: event.clientX,
      startValue: level,
      dragging: false,
    };
  }, [level]);

  const onPointerMove = useCallback((event) => {
    const drag = dragRef.current;
    if (!drag || event.buttons === 0) return;
    const dx = event.clientX - drag.startX;
    if (!drag.dragging) {
      if (Math.abs(dx) <= DEAD_ZONE_PX) return;
      drag.dragging = true;
    }
    const val = clamp(drag.startValue + dx * PX_PER_PERCENT);
    setDragLevel(val);
    commands.roomDim(roomId, val);
  }, [roomId]);

  const endDrag = useCallback((event) => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;
    if (!drag.dragging) {
      commands.roomToggle(roomId);
      setDragLevel(null);
      return;
    }
    const dx = event.clientX - drag.startX;
    const val = clamp(drag.startValue + dx * PX_PER_PERCENT);
    commands.roomDim(roomId, val, { commit: true });
    setDragLevel(null);
  }, [roomId]);

  const stateLabel = on
    ? (displayLevel > 0 && displayLevel < 100 ? `On · ${Math.round(displayLevel)}%` : 'On')
    : 'Off';

  return (
    <button
      type="button"
      class={`room-toggle${on ? ' is-on' : ''}`}
      style={{ '--room-fill': `${fillPct}%` }}
      aria-pressed={on}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      <span class="room-toggle-label">{roomLabel} lights</span>
      <span class="room-toggle-state">{stateLabel}</span>
    </button>
  );
}

export default RoomToggle;
