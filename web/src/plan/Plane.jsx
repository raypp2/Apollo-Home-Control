// Apollo v2 dashboard -- isometric floorplan surface (increment 2, "Beacon v3").
//
// Two nested wrappers so two animations compose without fighting each other:
//   .plan-outer -- a continuous idle sway (CSS keyframes, always running).
//   .plan-inner -- the base isometric transform, plus a per-selection pan/tilt
//                  recomputed here whenever ui.selectedRoom changes.
// Both wrappers sit around the same 470x980 plane-space coordinate box that
// Room/Furniture/Fixture position their children within.

import { store, ui } from '../state/index.js';
import Room from './Room.jsx';
import './plan.css';

const PLANE_W = 470;
const PLANE_H = 980;
const BASE_ROTATE_Z = -38;
const CENTER_X = PLANE_W / 2; // 235
const CENTER_Y = PLANE_H / 2; // 490

const BASE_TRANSFORM = `perspective(1600px) rotateX(55deg) rotateZ(${BASE_ROTATE_Z}deg) scale(.8)`;

/**
 * Recomputes the inner wrapper's transform for the current selection.
 * With nothing selected, falls back to the neutral base transform. With a
 * room selected, the plane tilts a little further toward that room's corner
 * (rotateZ nudge) and pans so the room's center approaches the plane's
 * center (post-transform translate) -- rooms may end up panned partly off
 * viewport at the extremes, which is an accepted tradeoff of this design.
 * @param {object|null} room
 * @returns {string}
 */
function innerTransform(room) {
  if (!room) return BASE_TRANSFORM;

  const cx = room.rect.x + room.rect.w / 2;
  const cy = room.rect.y + room.rect.h / 2;
  const rotateZ = BASE_ROTATE_Z + (CENTER_Y - cy) * 0.012 + (cx - CENTER_X) * 0.02;
  const tx = (CENTER_X - cx) * 0.62;
  const ty = (CENTER_Y - cy) * 0.52;

  return `perspective(1600px) rotateX(55deg) rotateZ(${rotateZ}deg) scale(.8) translate(${tx}px, ${ty}px)`;
}

export default function Plane() {
  const rooms = store.rooms.value;
  const selectedId = ui.selectedRoom.value;
  const selectedRoom = selectedId ? rooms.find((r) => r.id === selectedId) || null : null;

  return (
    <div class="plan-stage">
      <div class="plan-caption">FLOOR 1 · TAP A ROOM</div>

      <div class="plan-outer">
        <div class="plan-inner" style={{ transform: innerTransform(selectedRoom) }}>
          {rooms.map((room) => (
            <Room key={room.id} room={room} />
          ))}
        </div>
      </div>
    </div>
  );
}
