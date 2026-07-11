// Apollo v2 dashboard -- open-plan zone geometry.
//
// Rooms sharing a `zone` id (rooms.json) are one continuous open space --
// no interior walls between them. This module turns a set of member room
// rects into:
//   1. a single traced outline of their rectilinear union (for ZoneOutline),
//   2. the snapped per-member rects used to clip the zone's glow layer,
//   3. a ray-vs-union distance helper so a directional beam's wall hit is
//      computed against the WHOLE zone, not just the fixture's home room.
//
// Member rects are nearly, but not exactly, flush at shared walls (e.g.
// x=200 vs x=202, y=443 vs y=443.097 -- Illustrator/SVG export rounding).
// Everything here works in a "snapped" coordinate space where nearby edge
// coordinates are first collapsed to one shared value, so the union has no
// hairline gaps or slivers.
//
// Pure geometry, no JSX/DOM -- reusable by both ZoneOutline and the zone
// glow layer in GlowLayer.jsx.

const SNAP_TOLERANCE = 4;
const EPS = 1e-6;

/**
 * @param {{x:number,y:number,w:number,h:number}} rect
 * @returns {{x1:number,y1:number,x2:number,y2:number}}
 */
function toBounds(rect) {
  return { x1: rect.x, y1: rect.y, x2: rect.x + rect.w, y2: rect.y + rect.h };
}

/**
 * Cluster nearby numeric values within `tolerance` of an anchor (the first,
 * lowest value that started the cluster) and map every value to that
 * anchor. Anchor-based (not running-mean) so a long run of small steps
 * can't drift the snapped position past the tolerance from where it started.
 * @param {number[]} values
 * @param {number} tolerance
 * @returns {Map<number, number>}
 */
function snapMap(values, tolerance = SNAP_TOLERANCE) {
  const sorted = [...new Set(values)].sort((a, b) => a - b);
  const map = new Map();
  let anchor = null;
  for (const v of sorted) {
    if (anchor === null || v - anchor > tolerance) anchor = v;
    map.set(v, anchor);
  }
  return map;
}

/**
 * Snap a list of rects' edges to shared coordinates so members that are
 * meant to be flush actually are, in both axes independently.
 * @param {Array<{x:number,y:number,w:number,h:number}>} rects
 * @returns {Array<{x1:number,y1:number,x2:number,y2:number}>}
 */
export function snapRects(rects) {
  const bounds = rects.map(toBounds);
  const xMap = snapMap(bounds.flatMap((b) => [b.x1, b.x2]));
  const yMap = snapMap(bounds.flatMap((b) => [b.y1, b.y2]));
  return bounds.map((b) => ({
    x1: xMap.get(b.x1),
    x2: xMap.get(b.x2),
    y1: yMap.get(b.y1),
    y2: yMap.get(b.y2),
  }));
}

function pointKey([x, y]) {
  return `${x}:${y}`;
}

/**
 * Drop collinear intermediate points from a closed loop (consecutive grid
 * edges along the same wall collapse to their two endpoints) so the emitted
 * SVG path is a handful of corners, not one segment per grid cell.
 * @param {Array<[number,number]>} points
 * @returns {Array<[number,number]>}
 */
function simplifyLoop(points) {
  const n = points.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    const prev = points[(i - 1 + n) % n];
    const cur = points[i];
    const next = points[(i + 1) % n];
    const cross = (cur[0] - prev[0]) * (next[1] - cur[1]) - (cur[1] - prev[1]) * (next[0] - cur[0]);
    if (Math.abs(cross) > EPS) out.push(cur);
  }
  return out.length >= 3 ? out : points;
}

/**
 * Chain an unordered bag of unit boundary edges into closed loops by
 * walking shared endpoints. Each edge is indexed for traversal in either
 * direction; a vertex where more than two boundary edges meet (two loops
 * touching at a single point) just takes the first unused edge found --
 * an accepted simplification for the layouts this renders.
 * @param {Array<[[number,number],[number,number]]>} edges
 * @returns {Array<Array<[number,number]>>}
 */
function chainEdges(edges) {
  const adjacency = new Map();
  edges.forEach((edge, idx) => {
    const [a, b] = edge;
    for (const [from, to] of [[a, b], [b, a]]) {
      const k = pointKey(from);
      if (!adjacency.has(k)) adjacency.set(k, []);
      adjacency.get(k).push({ edgeIdx: idx, to });
    }
  });

  const used = new Set();
  const loops = [];
  for (let start = 0; start < edges.length; start++) {
    if (used.has(start)) continue;
    used.add(start);
    const [first, second] = edges[start];
    const loop = [first];
    let current = second;
    let guard = edges.length * 2 + 4;
    while (!(current[0] === first[0] && current[1] === first[1]) && guard-- > 0) {
      loop.push(current);
      const candidates = adjacency.get(pointKey(current)) || [];
      const next = candidates.find((c) => !used.has(c.edgeIdx));
      if (!next) break;
      used.add(next.edgeIdx);
      current = next.to;
    }
    if (loop.length >= 3) loops.push(simplifyLoop(loop));
  }
  return loops;
}

/**
 * Rectilinear union boundary trace: grid-decompose the plane by every
 * snapped edge coordinate, mark each cell inside/outside by its center
 * point, then collect + chain the edges where inside meets outside.
 * Handles any number of disjoint loops (and holes, via the caller's
 * fill-rule="evenodd") generically -- not special-cased to any one layout.
 * @param {Array<{x1:number,y1:number,x2:number,y2:number}>} snappedBounds
 * @returns {{ loops: Array<Array<[number,number]>>, bbox: {x:number,y:number,w:number,h:number} }}
 */
export function traceUnion(snappedBounds) {
  const xs = [...new Set(snappedBounds.flatMap((b) => [b.x1, b.x2]))].sort((a, b) => a - b);
  const ys = [...new Set(snappedBounds.flatMap((b) => [b.y1, b.y2]))].sort((a, b) => a - b);
  const cols = xs.length - 1;
  const rows = ys.length - 1;

  const insideCell = (i, j) => {
    if (i < 0 || j < 0 || i >= cols || j >= rows) return false;
    const cx = (xs[i] + xs[i + 1]) / 2;
    const cy = (ys[j] + ys[j + 1]) / 2;
    return snappedBounds.some((b) => cx > b.x1 && cx < b.x2 && cy > b.y1 && cy < b.y2);
  };

  const edges = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      if (!insideCell(i, j)) continue;
      if (!insideCell(i, j - 1)) edges.push([[xs[i], ys[j]], [xs[i + 1], ys[j]]]); // top
      if (!insideCell(i, j + 1)) edges.push([[xs[i + 1], ys[j + 1]], [xs[i], ys[j + 1]]]); // bottom
      if (!insideCell(i - 1, j)) edges.push([[xs[i], ys[j + 1]], [xs[i], ys[j]]]); // left
      if (!insideCell(i + 1, j)) edges.push([[xs[i + 1], ys[j]], [xs[i + 1], ys[j + 1]]]); // right
    }
  }

  const loops = chainEdges(edges);
  const bbox = {
    x: xs[0],
    y: ys[0],
    w: xs[xs.length - 1] - xs[0],
    h: ys[ys.length - 1] - ys[0],
  };
  return { loops, bbox };
}

/**
 * @param {Array<Array<[number,number]>>} loops
 * @returns {string} SVG path `d`, one "M...Z" subpath per loop -- pair with
 *          fill-rule="evenodd" so an enclosed non-member loop renders as a
 *          hole automatically.
 */
export function loopsToPath(loops) {
  return loops
    .map((loop) => `M${loop.map(([x, y]) => `${x},${y}`).join('L')}Z`)
    .join(' ');
}

const geometryCache = new Map();

/**
 * Traced union + snapped bounds + bbox-relative outline path for one zone,
 * memoized per zone id. Rooms are static after load (hydrated once from
 * config/rooms.json), so the cache is invalidated only if a member room's
 * rect signature actually changes (defensive, e.g. hot-reload in dev).
 * @param {string} zoneName
 * @param {Array<{id:string, rect:{x:number,y:number,w:number,h:number}}>} members
 * @returns {{ snapped: Array<object>, loops: Array, bbox: object, path: string }}
 */
export function getZoneGeometry(zoneName, members) {
  const signature = members.map((r) => `${r.id}:${r.rect.x}:${r.rect.y}:${r.rect.w}:${r.rect.h}`).join('|');
  const cached = geometryCache.get(zoneName);
  if (cached && cached.signature === signature) return cached.geometry;

  const snapped = snapRects(members.map((r) => r.rect));
  const { loops, bbox } = traceUnion(snapped);
  const relLoops = loops.map((loop) => loop.map(([x, y]) => [x - bbox.x, y - bbox.y]));
  const geometry = { snapped, loops, bbox, path: loopsToPath(relLoops) };

  geometryCache.set(zoneName, { signature, geometry });
  return geometry;
}

/**
 * Group non-decorative rooms by their `zone` field, preserving rooms.json
 * order within each group. Rooms without a `zone` are omitted.
 * @param {Array<object>} rooms
 * @returns {Array<{ name: string, members: Array<object> }>}
 */
export function groupZones(rooms) {
  const map = new Map();
  for (const room of rooms) {
    if (!room.zone) continue;
    if (!map.has(room.zone)) map.set(room.zone, []);
    map.get(room.zone).push(room);
  }
  return [...map.entries()].map(([name, members]) => ({ name, members }));
}

/**
 * Ray-vs-rect slab intersection: the [tEnter,tExit] interval (in units of
 * the ray's own dx,dy, clamped to tEnter>=0) where the ray from (x,y)
 * crosses `b`, or null if it never does (or only crosses behind the
 * origin).
 * @param {number} x
 * @param {number} y
 * @param {number} dx unit direction
 * @param {number} dy unit direction
 * @param {{x1:number,y1:number,x2:number,y2:number}} b
 * @returns {[number, number]|null}
 */
function rayRectInterval(x, y, dx, dy, b) {
  let tMin = -Infinity;
  let tMax = Infinity;

  if (Math.abs(dx) < EPS) {
    if (x < b.x1 || x > b.x2) return null;
  } else {
    let t1 = (b.x1 - x) / dx;
    let t2 = (b.x2 - x) / dx;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
  }

  if (Math.abs(dy) < EPS) {
    if (y < b.y1 || y > b.y2) return null;
  } else {
    let t1 = (b.y1 - y) / dy;
    let t2 = (b.y2 - y) / dy;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
  }

  if (tMin > tMax + EPS) return null;
  if (tMax < -EPS) return null;
  return [Math.max(tMin, 0), tMax];
}

/**
 * Distance a ray travels from (x,y) before leaving the union of
 * `snappedBounds` -- the zone-aware replacement for a single room's
 * wallHit() distance. Computes each member rect's ray interval, merges
 * overlapping/touching ones, and returns the far edge of whichever merged
 * interval contains t=0 (the fixture's own home rect) -- so a beam crossing
 * a former interior wall keeps going until the real (union) boundary.
 * @param {number} x fixture x, same coordinate space as snappedBounds
 * @param {number} y fixture y
 * @param {number} dx unit direction
 * @param {number} dy unit direction
 * @param {Array<{x1:number,y1:number,x2:number,y2:number}>} snappedBounds
 * @returns {number} distance along the ray to the union's edge
 */
export function rayUnionDistance(x, y, dx, dy, snappedBounds) {
  const intervals = [];
  for (const b of snappedBounds) {
    const iv = rayRectInterval(x, y, dx, dy, b);
    if (iv) intervals.push(iv);
  }
  if (!intervals.length) return 0;

  intervals.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const iv of intervals) {
    const last = merged[merged.length - 1];
    if (last && iv[0] <= last[1] + SNAP_TOLERANCE) {
      last[1] = Math.max(last[1], iv[1]);
    } else {
      merged.push([...iv]);
    }
  }

  const containing = merged.find(([a, b]) => a <= EPS && b >= -EPS);
  if (containing) return containing[1];
  return merged[0][1];
}
