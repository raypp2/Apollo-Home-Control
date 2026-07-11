// Apollo v2 dashboard -- open-plan zone outline.
//
// Draws the single traced outline of an open-plan zone's member rooms (see
// zoneGeometry.js), replacing each member's own .plan-room border/background
// -- one continuous surface with no interior wall strokes, matching the
// existing per-room border look. Selected treatment (the purple glow a
// plain room gets via .plan-room__selected-overlay) applies to the whole
// outline together when the zone is selected, since all members select as
// one (see ui.selectRoom / Room.jsx).

import { ui } from '../state/index.js';

/**
 * @param {{ zoneName: string, geometry: { bbox: {x:number,y:number,w:number,h:number}, path: string } }} props
 */
export default function ZoneOutline({ zoneName, geometry }) {
  const { bbox, path } = geometry;
  const selected = ui.selectedRoom.value === zoneName;

  return (
    <svg
      class={`plan-zone__outline${selected ? ' plan-zone__outline--selected' : ''}`}
      style={{ left: `${bbox.x}px`, top: `${bbox.y}px` }}
      width={bbox.w}
      height={bbox.h}
      viewBox={`0 0 ${bbox.w} ${bbox.h}`}
      aria-hidden="true"
    >
      <path d={path} fill-rule="evenodd" class="plan-zone__outline-shape" />
    </svg>
  );
}
