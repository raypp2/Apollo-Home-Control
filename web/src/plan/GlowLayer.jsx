// Apollo v2 dashboard -- per-fixture directional light layer.
//
// Replaces the room-centered occupancy wash for fixture positions that carry
// emission metadata in rooms.json. A fixture position may extend {x,y} with:
//   aim     degrees the lamp points, screen coords on the plan: 0 = +x
//           (toward the right wall), 90 = +y (down), 270 = up.
//   spread  full beam angle in degrees (optional, default 70).
// For each such fixture that is on, three stacked shapes render in the
// device's live color, clipped to the room by the svg viewport:
//   1. a beam wedge from the fixture to where its aim ray hits the room wall,
//   2. a bright elongated pool on that wall,
//   3. a large dim "bounce" gradient centered on the wall hit, spilling back
//      into the room -- fake radiosity; reads as the lit wall lighting the
//      space, which is what a wall-facing lamp actually does.
// Shapes use mix-blend-mode: screen so overlapping lamps add rather than
// just stack alpha. Gradient/filter defs get room+position-scoped ids (SVG
// ids are document-global). Occlusion by furniture is deliberately ignored.

import { store, commands } from '../state/index.js';
import { withAlpha } from './Fixture.jsx';

const DEFAULT_GLOW = '#ffb267';
const DEFAULT_SPREAD = 70;

/**
 * Walk the aim ray from a fixture position to the room rect's edge.
 * @param {{x:number,y:number,aim:number}} pos
 * @param {number} w room width
 * @param {number} h room height
 * @returns {{hx:number,hy:number,dx:number,dy:number,t:number}} wall hit
 *          point, unit direction, and distance along the ray
 */
function wallHit(pos, w, h) {
  const rad = (pos.aim * Math.PI) / 180;
  const dx = Math.cos(rad);
  const dy = Math.sin(rad);
  let t = Infinity;
  if (dx > 1e-6) t = Math.min(t, (w - pos.x) / dx);
  if (dx < -1e-6) t = Math.min(t, -pos.x / dx);
  if (dy > 1e-6) t = Math.min(t, (h - pos.y) / dy);
  if (dy < -1e-6) t = Math.min(t, -pos.y / dy);
  if (!Number.isFinite(t) || t < 0) t = 0;
  return { hx: pos.x + dx * t, hy: pos.y + dy * t, dx, dy, t };
}

/**
 * One fixture position's glow: wedge + wall pool + bounce. Rendered inside
 * the room's <svg>; fades via group opacity so on/off transitions smoothly.
 * @param {{ pos: object, view: object, idBase: string, w: number, h: number }} props
 */
function FixtureGlow({ pos, view, idBase, w, h }) {
  const color = view.color || DEFAULT_GLOW;
  const { hx, hy, dx, dy, t } = wallHit(pos, w, h);

  const spread = pos.spread || DEFAULT_SPREAD;
  const halfWidth = Math.max(6, t * Math.tan(((spread / 2) * Math.PI) / 180));
  // Perpendicular to the aim = direction along the wall being washed.
  const px = -dy;
  const py = dx;
  const wallAngle = (Math.atan2(py, px) * 180) / Math.PI;

  const wedgePoints = `${pos.x},${pos.y} ${hx + px * halfWidth},${hy + py * halfWidth} ${hx - px * halfWidth},${hy - py * halfWidth}`;
  const bounceR = Math.max(w, h) * 0.55;

  // Dimmed lamps glow proportionally; opacity 0 (not unmount) when off so
  // the .4s fade runs in both directions.
  const intensity = view.on ? 0.45 + 0.55 * (view.level / 100) : 0;

  return (
    <g class="plan-glow" style={{ opacity: intensity }}>
      <defs>
        <radialGradient id={`${idBase}-bounce`} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stop-color={withAlpha(color, 0.5)} />
          <stop offset="45%" stop-color={withAlpha(color, 0.22)} />
          <stop offset="100%" stop-color={withAlpha(color, 0)} />
        </radialGradient>
        <linearGradient
          id={`${idBase}-wedge`}
          gradientUnits="userSpaceOnUse"
          x1={pos.x} y1={pos.y} x2={hx} y2={hy}
        >
          <stop offset="0%" stop-color={withAlpha(color, 0.6)} />
          <stop offset="100%" stop-color={withAlpha(color, 0.25)} />
        </linearGradient>
        <filter id={`${idBase}-soft`} x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="3" />
        </filter>
        <filter id={`${idBase}-softer`} x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="8" />
        </filter>
      </defs>
      <circle
        cx={hx} cy={hy} r={bounceR}
        fill={`url(#${idBase}-bounce)`}
        filter={`url(#${idBase}-softer)`}
        style={{ mixBlendMode: 'screen' }}
      />
      <polygon
        points={wedgePoints}
        fill={`url(#${idBase}-wedge)`}
        filter={`url(#${idBase}-soft)`}
        style={{ mixBlendMode: 'screen' }}
      />
      <ellipse
        cx={hx} cy={hy}
        rx={halfWidth * 1.1} ry={7}
        transform={`rotate(${wallAngle} ${hx} ${hy})`}
        fill={withAlpha(color, 0.75)}
        filter={`url(#${idBase}-soft)`}
        style={{ mixBlendMode: 'screen' }}
      />
    </g>
  );
}

/**
 * The room's light layer: one <svg> over the room rect holding every aimed
 * fixture's glow. Only mounted when the room has aimed fixtures (Room.jsx
 * filters), so plain rooms pay nothing.
 * @param {{ room: object, fixtures: Array<{deviceId:string,pos:object,key:string}> }} props
 */
export default function GlowLayer({ room, fixtures }) {
  const entries = store.devicesInRoom(room.id);
  const { w, h } = room.rect;

  return (
    <svg
      class="plan-room__lightlayer"
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      aria-hidden="true"
    >
      {fixtures.map(({ deviceId, pos, key }) => {
        const entry = entries.find((e) => e.id === deviceId);
        if (!entry) return null;
        return (
          <FixtureGlow
            key={key}
            pos={pos}
            view={commands.deviceView(entry)}
            idBase={`glow-${room.id}-${key}`}
            w={w}
            h={h}
          />
        );
      })}
    </svg>
  );
}
