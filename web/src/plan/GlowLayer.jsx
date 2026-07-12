// Apollo v2 dashboard -- per-fixture light layer.
//
// Replaces the room-centered occupancy wash: every fixture position emits
// from where the lamp actually sits. A fixture position may extend {x,y}
// with:
//   aim       degrees the lamp points, screen coords on the plan: 0 = +x
//             (toward the right wall), 90 = +y (down), 270 = up.
//   spread    full beam angle in degrees (optional, default 70).
//   w, h      emitting area of a RECTANGULAR source (e.g. an LED strip) --
//             x,y is then the rect's CENTER, not a point lamp (RectGlow).
//   glow      "rainbow" on a rect source swaps the device's live color for
//             a subtle static spectrum gradient (see RectGlow).
//   intensity optional per-fixture brightness multiplier (~0.2-1.5, default
//             1), applied on top of every glow type's own on/level formula.
// A position WITHOUT an aim (and without w/h) is a plain omnidirectional
// lamp: a single radial pool centered on the fixture dot (OmniGlow).
// A position WITH an AXIS-ALIGNED aim (within AXIS_TOLERANCE of 0/90/180/
// 270 -- i.e. pointing square at a wall) renders three stacked shapes in
// the device's live color, clipped to the room by the svg viewport
// (FixtureGlow):
//   1. a beam wedge from the fixture to where its aim ray hits the room wall,
//   2. a bright elongated pool on that wall,
//   3. a large dim "bounce" gradient centered on the wall hit, spilling back
//      into the room -- fake radiosity; reads as the lit wall lighting the
//      space, which is what a wall-facing lamp actually does.
// A position with an OFF-AXIS aim skips the wall treatment entirely -- a
// diagonal ray hits the wall at a glancing angle and the rotated pool
// ellipse reads as an artificial straight-line hotspot (per Ray). Those
// lamps just EMIT from themselves: the same wedge but fading to nothing
// before the wall, plus a soft pool at the lamp position.
// Shapes use mix-blend-mode: screen so overlapping lamps add rather than
// just stack alpha. Gradient/filter defs get room+position-scoped ids (SVG
// ids are document-global). Occlusion by furniture is deliberately ignored.

import { store, commands } from '../state/index.js';
import { withAlpha } from './Fixture.jsx';
import { flattenFixtures } from './fixtures.js';
import { rayUnionDistance } from './zoneGeometry.js';

const DEFAULT_GLOW = '#ffb267';
const DEFAULT_SPREAD = 70;

// Degrees of slack around 0/90/180/270 within which an aim still counts as
// "pointing square at a wall" and gets the full wall-wash treatment. Beyond
// it the lamp is off-axis and emits from itself instead (see module doc).
const AXIS_TOLERANCE = 10;

/**
 * @param {number} aim degrees
 * @returns {boolean} true when the aim is within AXIS_TOLERANCE of an axis
 */
function isAxisAligned(aim) {
  const m = ((aim % 90) + 90) % 90;
  return m <= AXIS_TOLERANCE || m >= 90 - AXIS_TOLERANCE;
}

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
 * `hit` (the wall-hit point + ray direction + distance) is precomputed by
 * the caller -- FixtureGlow uses the single-room wallHit(), ZoneFixtureGlow
 * uses the union-aware rayUnionDistance() -- so this rendering half is
 * shared between a plain room and a zone member unchanged.
 * @param {{ pos: object, hit: {hx:number,hy:number,dx:number,dy:number,t:number}, view: object, idBase: string, w: number, h: number }} props
 */
function FixtureGlowVisual({ pos, hit, view, idBase, w, h }) {
  const color = view.color || DEFAULT_GLOW;
  const { hx, hy, dx, dy, t } = hit;
  const axisAligned = isAxisAligned(pos.aim);

  const spread = pos.spread || DEFAULT_SPREAD;
  const halfWidth = Math.max(6, t * Math.tan(((spread / 2) * Math.PI) / 180));
  // Perpendicular to the aim = direction along the wall being washed.
  const px = -dy;
  const py = dx;
  const wallAngle = (Math.atan2(py, px) * 180) / Math.PI;

  const wedgePoints = `${pos.x},${pos.y} ${hx + px * halfWidth},${hy + py * halfWidth} ${hx - px * halfWidth},${hy - py * halfWidth}`;
  const bounceR = Math.max(w, h) * 0.55;

  // Dimmed lamps glow proportionally; opacity 0 (not unmount) when off so
  // the .4s fade runs in both directions. Directional beams run at a lower
  // base than OmniGlow's -- at full alpha they tended to overshadow other
  // fixtures in the same room. `pos.intensity` is an optional per-fixture
  // brightness multiplier (config/rooms.json), default 1.
  const intensity = (view.on ? 0.34 + 0.42 * (view.level / 100) : 0) * (pos.intensity ?? 1);

  return (
    <g class="plan-glow" style={{ opacity: intensity }}>
      <defs>
        {axisAligned && (
          <radialGradient id={`${idBase}-bounce`} cx="50%" cy="50%" r="50%">
            <stop offset="0%" stop-color={withAlpha(color, 0.5)} />
            <stop offset="45%" stop-color={withAlpha(color, 0.22)} />
            <stop offset="100%" stop-color={withAlpha(color, 0)} />
          </radialGradient>
        )}
        {!axisAligned && (
          <radialGradient id={`${idBase}-source`} cx="50%" cy="50%" r="50%">
            <stop offset="0%" stop-color={withAlpha(color, 0.55)} />
            <stop offset="45%" stop-color={withAlpha(color, 0.2)} />
            <stop offset="100%" stop-color={withAlpha(color, 0)} />
          </radialGradient>
        )}
        <linearGradient
          id={`${idBase}-wedge`}
          gradientUnits="userSpaceOnUse"
          x1={pos.x} y1={pos.y} x2={hx} y2={hy}
        >
          {axisAligned ? (
            <>
              <stop offset="0%" stop-color={withAlpha(color, 0.6)} />
              <stop offset="100%" stop-color={withAlpha(color, 0.25)} />
            </>
          ) : (
            <>
              {/* Off-axis: brightness lives at the lamp and the beam dies
                  out before the wall -- no terminus edge, no wall hotspot. */}
              <stop offset="0%" stop-color={withAlpha(color, 0.65)} />
              <stop offset="55%" stop-color={withAlpha(color, 0.22)} />
              <stop offset="100%" stop-color={withAlpha(color, 0)} />
            </>
          )}
        </linearGradient>
        <filter id={`${idBase}-soft`} x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="3" />
        </filter>
        <filter id={`${idBase}-softer`} x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="8" />
        </filter>
      </defs>
      {axisAligned && (
        <circle
          cx={hx} cy={hy} r={bounceR}
          fill={`url(#${idBase}-bounce)`}
          filter={`url(#${idBase}-softer)`}
          style={{ mixBlendMode: 'screen' }}
        />
      )}
      {!axisAligned && (
        <circle
          cx={pos.x} cy={pos.y} r={Math.max(w, h) * 0.28}
          fill={`url(#${idBase}-source)`}
          filter={`url(#${idBase}-softer)`}
          style={{ mixBlendMode: 'screen' }}
        />
      )}
      <polygon
        points={wedgePoints}
        fill={`url(#${idBase}-wedge)`}
        filter={`url(#${idBase}-soft)`}
        style={{ mixBlendMode: 'screen' }}
      />
      {axisAligned && (
        <ellipse
          cx={hx} cy={hy}
          rx={halfWidth * 1.1} ry={7}
          transform={`rotate(${wallAngle} ${hx} ${hy})`}
          fill={withAlpha(color, 0.6)}
          filter={`url(#${idBase}-soft)`}
          style={{ mixBlendMode: 'screen' }}
        />
      )}
    </g>
  );
}

/**
 * FixtureGlowVisual for a plain (non-zoned) room: wall hit computed against
 * that one room's own rect (w,h), same as always.
 * @param {{ pos: object, view: object, idBase: string, w: number, h: number }} props
 */
function FixtureGlow({ pos, view, idBase, w, h }) {
  const hit = wallHit(pos, w, h);
  return <FixtureGlowVisual pos={pos} hit={hit} view={view} idBase={idBase} w={w} h={h} />;
}

/**
 * FixtureGlowVisual for a zone member room: wall hit computed against the
 * UNION of every member's (snapped) rect, so a beam crossing a former
 * interior wall keeps going until the real zone boundary instead of
 * stopping at the invisible member edge. `pos` and the returned hit point
 * are both in the zone's bbox-relative coordinate space (what the caller's
 * <svg viewBox> uses); `w,h` stay the fixture's HOME room dims so the
 * bounce-pool size reads the same as the single-room case.
 * @param {{ pos: object, view: object, idBase: string, w: number, h: number, snappedBounds: Array<object> }} props
 */
function ZoneFixtureGlow({ pos, view, idBase, w, h, snappedBounds }) {
  const rad = (pos.aim * Math.PI) / 180;
  const dx = Math.cos(rad);
  const dy = Math.sin(rad);
  const t = rayUnionDistance(pos.x, pos.y, dx, dy, snappedBounds);
  const hit = { hx: pos.x + dx * t, hy: pos.y + dy * t, dx, dy, t };
  return <FixtureGlowVisual pos={pos} hit={hit} view={view} idBase={idBase} w={w} h={h} />;
}

/**
 * One non-aimed fixture position's glow: a single radial pool centered on
 * the lamp itself, emitting 360deg. Sized to the room so one lamp still
 * reads as lighting the space, not a spotlight dot.
 * @param {{ pos: object, view: object, idBase: string, w: number, h: number }} props
 */
function OmniGlow({ pos, view, idBase, w, h }) {
  const color = view.color || DEFAULT_GLOW;
  const r = Math.max(w, h) * 0.55;
  const intensity = (view.on ? 0.45 + 0.55 * (view.level / 100) : 0) * (pos.intensity ?? 1);

  return (
    <g class="plan-glow" style={{ opacity: intensity }}>
      <defs>
        <radialGradient id={`${idBase}-omni`} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stop-color={withAlpha(color, 0.6)} />
          <stop offset="40%" stop-color={withAlpha(color, 0.26)} />
          <stop offset="100%" stop-color={withAlpha(color, 0)} />
        </radialGradient>
      </defs>
      <circle
        cx={pos.x} cy={pos.y} r={r}
        fill={`url(#${idBase}-omni)`}
        style={{ mixBlendMode: 'screen' }}
      />
    </g>
  );
}

// Low-alpha, hand-picked hue stops for RectGlow's "rainbow" spectrum -- a
// hint of color along the strip, not a saturated rainbow. Deliberately
// static (no animation): the ask was "a little bit of a rainbow sort of
// glow", not a moving light show.
const RAINBOW_STOPS = [
  ['0%', '#ff3b3b'],
  ['17%', '#ff9a3b'],
  ['34%', '#ffe93b'],
  ['50%', '#3bff5e'],
  ['67%', '#3bb8ff'],
  ['84%', '#6a3bff'],
  ['100%', '#c23bff'],
];
const RAINBOW_ALPHA = 0.4;

/**
 * Which way a rect emitter's wash should spill into the room: away from
 * whichever of the fixture's HOME room's four walls it sits closest to.
 * Computed from `localPos` -- the fixture's untranslated, room-relative
 * {x,y} -- even when the caller is about to render in a zone's shared bbox
 * space, so a strip mounted flush against a room's own right wall always
 * washes left regardless of where "right" lands once the zone's other
 * members shift the coordinate origin.
 * @param {{x:number,y:number}} localPos
 * @param {number} homeW
 * @param {number} homeH
 * @returns {{nx:number,ny:number}} unit vector pointing into the room
 */
function wallAwayDirection(localPos, homeW, homeH) {
  const distLeft = localPos.x;
  const distRight = homeW - localPos.x;
  const distTop = localPos.y;
  const distBottom = homeH - localPos.y;
  const min = Math.min(distLeft, distRight, distTop, distBottom);
  if (min === distRight) return { nx: -1, ny: 0 };
  if (min === distTop) return { nx: 0, ny: 1 };
  if (min === distBottom) return { nx: 0, ny: -1 };
  return { nx: 1, ny: 0 }; // nearest wall is left
}

/**
 * A RECTANGULAR light source -- e.g. an LED strip run behind furniture --
 * instead of a point lamp or an aimed beam. `pos.x,pos.y` is the rect's
 * CENTER, `pos.w,pos.h` its emitting area. Renders two pieces:
 *   1. the emitter rect itself, filled with the source color (or the
 *      rainbow gradient) and softly blurred;
 *   2. a wash spilling from the rect's wall-facing long side into the
 *      room -- a blurred rect stretched in the away direction, faded out
 *      with distance via a linear alpha gradient (rainbow: the fade is
 *      applied as a mask over the same spectrum fill, so hue keeps
 *      varying along the strip while alpha fades outward into the room).
 * `w,h` are the fixture's HOME room dims (OmniGlow/FixtureGlow convention)
 * used only to size the wash's reach; `localPos` is the untranslated
 * room-relative position used to infer which wall the rect is mounted
 * against (see wallAwayDirection).
 * @param {{ pos: object, view: object, idBase: string, w: number, h: number, localPos: {x:number,y:number} }} props
 */
function RectGlow({ pos, view, idBase, w, h, localPos }) {
  const color = view.color || DEFAULT_GLOW;
  const rw = pos.w;
  const rh = pos.h;
  const halfW = rw / 2;
  const halfH = rh / 2;
  const rainbow = pos.glow === 'rainbow';
  const vertical = rh >= rw;

  // Same on/level formula as OmniGlow -- a rect source reads like any other
  // fixture, just shaped differently. `pos.intensity` is the optional
  // per-fixture brightness multiplier.
  const intensity = (view.on ? 0.45 + 0.55 * (view.level / 100) : 0) * (pos.intensity ?? 1);

  const { nx, ny } = wallAwayDirection(localPos, w, h);
  const washDepth = Math.max(w, h) * 0.3;
  const washCross = Math.max(rw, rh) * 1.2;

  const edgeX = pos.x + nx * halfW;
  const edgeY = pos.y + ny * halfH;
  const farX = edgeX + nx * washDepth;
  const farY = edgeY + ny * washDepth;

  const washX = nx !== 0 ? Math.min(edgeX, farX) : pos.x - washCross / 2;
  const washY = ny !== 0 ? Math.min(edgeY, farY) : pos.y - washCross / 2;
  const washW = nx !== 0 ? Math.abs(farX - edgeX) : washCross;
  const washH = ny !== 0 ? Math.abs(farY - edgeY) : washCross;

  // Long-axis anchor points for the emitter's own fill gradient -- along y
  // for a vertical strip, x for a horizontal one.
  const gx1 = vertical ? pos.x : pos.x - halfW;
  const gy1 = vertical ? pos.y - halfH : pos.y;
  const gx2 = vertical ? pos.x : pos.x + halfW;
  const gy2 = vertical ? pos.y + halfH : pos.y;

  return (
    <g class="plan-glow" style={{ opacity: intensity }}>
      <defs>
        <linearGradient id={`${idBase}-fill`} gradientUnits="userSpaceOnUse" x1={gx1} y1={gy1} x2={gx2} y2={gy2}>
          {rainbow ? (
            RAINBOW_STOPS.map(([offset, hex]) => (
              <stop key={offset} offset={offset} stop-color={withAlpha(hex, RAINBOW_ALPHA)} />
            ))
          ) : (
            <>
              <stop offset="0%" stop-color={withAlpha(color, 0.75)} />
              <stop offset="100%" stop-color={withAlpha(color, 0.55)} />
            </>
          )}
        </linearGradient>
        <linearGradient id={`${idBase}-wash-fade`} gradientUnits="userSpaceOnUse" x1={edgeX} y1={edgeY} x2={farX} y2={farY}>
          {rainbow ? (
            <>
              <stop offset="0%" stop-color="#fff" stop-opacity="0.85" />
              <stop offset="100%" stop-color="#fff" stop-opacity="0" />
            </>
          ) : (
            <>
              <stop offset="0%" stop-color={withAlpha(color, 0.4)} />
              <stop offset="100%" stop-color={withAlpha(color, 0)} />
            </>
          )}
        </linearGradient>
        {rainbow && (
          <mask id={`${idBase}-wash-mask`} maskUnits="userSpaceOnUse" x={washX - 20} y={washY - 20} width={washW + 40} height={washH + 40}>
            <rect x={washX} y={washY} width={washW} height={washH} fill={`url(#${idBase}-wash-fade)`} />
          </mask>
        )}
        <filter id={`${idBase}-rect-soft`} x="-80%" y="-80%" width="260%" height="260%">
          <feGaussianBlur stdDeviation="3" />
        </filter>
        <filter id={`${idBase}-wash-soft`} x="-80%" y="-80%" width="260%" height="260%">
          <feGaussianBlur stdDeviation="9" />
        </filter>
      </defs>
      <rect
        x={washX} y={washY} width={washW} height={washH}
        fill={rainbow ? `url(#${idBase}-fill)` : `url(#${idBase}-wash-fade)`}
        mask={rainbow ? `url(#${idBase}-wash-mask)` : undefined}
        filter={`url(#${idBase}-wash-soft)`}
        style={{ mixBlendMode: 'screen' }}
      />
      <rect
        x={pos.x - halfW} y={pos.y - halfH} width={rw} height={rh}
        fill={`url(#${idBase}-fill)`}
        filter={`url(#${idBase}-rect-soft)`}
        style={{ mixBlendMode: 'screen' }}
      />
    </g>
  );
}

/**
 * The room's light layer: one <svg> over the room rect holding every
 * fixture's glow -- directional (FixtureGlow) when the position has an aim,
 * a rectangular source (RectGlow) when it has w/h, omnidirectional pool
 * (OmniGlow) otherwise. Only mounted when the room has fixture dots
 * (Room.jsx filters), so bare rooms pay nothing.
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
        const view = commands.deviceView(entry);
        const idBase = `glow-${room.id}-${key}`;
        if (pos.w != null && pos.h != null) {
          return <RectGlow key={key} pos={pos} view={view} idBase={idBase} w={w} h={h} localPos={pos} />;
        }
        const Glow = pos.aim != null ? FixtureGlow : OmniGlow;
        return <Glow key={key} pos={pos} view={view} idBase={idBase} w={w} h={h} />;
      })}
    </svg>
  );
}

/**
 * The zone's light layer: one <svg> spanning the union bbox of every member
 * room, holding EVERY member's fixture glows (same OmniGlow/FixtureGlow
 * visuals as a plain room) in one shared coordinate space, so light spills
 * naturally across former interior walls. Mounted once per zone from
 * Plane.jsx, as a sibling of the (now background-less) member Room divs --
 * see Room.jsx's `zoned` skip of its own GlowLayer mount.
 *
 * - OmniGlow keeps a per-fixture pool radius sized by that fixture's HOME
 *   room dims (room.rect.w/h), same as the single-room case -- only its
 *   position is translated into bbox space.
 * - FixtureGlow's directional beams route through ZoneFixtureGlow, which
 *   swaps the single-room wallHit() for rayUnionDistance() against every
 *   member's snapped rect, so a beam crossing a former interior wall keeps
 *   going until it hits the zone's real (outer) boundary.
 * - RectGlow (rectangular sources) infers which wall it's mounted against
 *   from the fixture's ORIGINAL room-relative position (`localPos`), before
 *   it's translated into bbox space, so the wash direction is unaffected by
 *   where the room lands within the zone's shared coordinate space.
 * - A <clipPath> built from the same snapped member rects keeps glow from
 *   spilling onto a non-member room (bath/hall) that happens to fall inside
 *   the union's bounding box without being part of the union itself.
 * @param {{ zoneName: string, members: Array<object>, geometry: { bbox: object, snapped: Array<object> } }} props
 */
export function ZoneGlowLayer({ zoneName, members, geometry }) {
  const { bbox, snapped } = geometry;
  // Same snapped rects the outline/clip both key off, just re-based to the
  // bbox-relative coordinate space this <svg>'s viewBox uses.
  const relBounds = snapped.map((b) => ({
    x1: b.x1 - bbox.x,
    y1: b.y1 - bbox.y,
    x2: b.x2 - bbox.x,
    y2: b.y2 - bbox.y,
  }));
  const clipId = `zoneclip-${zoneName}`;

  const glows = [];
  members.forEach((room) => {
    const entries = store.devicesInRoom(room.id);
    const flat = flattenFixtures(room.fixtures);
    flat.forEach(({ deviceId, pos, key }) => {
      const entry = entries.find((e) => e.id === deviceId);
      if (!entry) return;
      const view = commands.deviceView(entry);
      const idBase = `zoneglow-${zoneName}-${room.id}-${key}`;
      // Fixture positions are stored room-relative (Fixture.jsx positions
      // them within their room div) -- offset by the member's own rect
      // origin, then into bbox space, to land in this shared <svg>. Spread
      // the original pos first so extra fields (w/h, glow, intensity) ride
      // along unchanged -- only x/y need translating.
      const relPos = {
        ...pos,
        x: room.rect.x + pos.x - bbox.x,
        y: room.rect.y + pos.y - bbox.y,
      };
      if (pos.w != null && pos.h != null) {
        glows.push(
          <RectGlow
            key={idBase}
            pos={relPos}
            view={view}
            idBase={idBase}
            w={room.rect.w}
            h={room.rect.h}
            localPos={pos}
          />,
        );
      } else if (pos.aim != null) {
        glows.push(
          <ZoneFixtureGlow
            key={idBase}
            pos={relPos}
            view={view}
            idBase={idBase}
            w={room.rect.w}
            h={room.rect.h}
            snappedBounds={relBounds}
          />,
        );
      } else {
        glows.push(
          <OmniGlow key={idBase} pos={relPos} view={view} idBase={idBase} w={room.rect.w} h={room.rect.h} />,
        );
      }
    });
  });

  return (
    <svg
      class="plan-zone__lightlayer"
      style={{ left: `${bbox.x}px`, top: `${bbox.y}px` }}
      width={bbox.w}
      height={bbox.h}
      viewBox={`0 0 ${bbox.w} ${bbox.h}`}
      aria-hidden="true"
    >
      <defs>
        <clipPath id={clipId}>
          {relBounds.map((b, i) => (
            <rect key={i} x={b.x1} y={b.y1} width={b.x2 - b.x1} height={b.y2 - b.y1} />
          ))}
        </clipPath>
      </defs>
      <g clip-path={`url(#${clipId})`}>{glows}</g>
    </svg>
  );
}
