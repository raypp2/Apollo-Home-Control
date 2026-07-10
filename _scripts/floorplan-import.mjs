#!/usr/bin/env node
// floorplan-import.mjs — read an edited floorplan SVG (see
// _scripts/floorplan-export.mjs) and reconstruct config/rooms.json.
//
// WHY: rooms.json positions are hand-guessed pixel coordinates. Exporting
// the plane to SVG lets the layout be nudged visually in Illustrator or
// Inkscape; this script converts the edited file back into rooms.json shape
// so those edits actually take effect.
//
// SAFETY: never overwrites config/rooms.json unless --write is passed. By
// default it writes config/rooms.json.imported (a new file, never tracked)
// alongside a diff summary printed to stdout, so you can review before
// clobbering the real config.
//
// PARSING APPROACH: no XML/DOM dependency. floorplan-export.mjs always
// emits one self-closing <rect .../> or <circle .../> per line with every
// attribute inline, plus <g transform="rotate(deg cx cy)"> wrapping only
// around rotated furniture items — a small, fully-controlled subset of SVG
// we can scan with regexes reliably. This is NOT a general SVG parser; see
// LIMITATIONS below for what happens when an editor rewrites the structure.
//
// ROOMS.JSON SCHEMA v2:
//   Room     — as before, but a `fixtures` value may be a single {x,y} OR
//              an array [{x,y}, ...] for a device with more than one dot on
//              the plan (all controlling the same device).
//   Decoration — { id, label, decorative: true, rect: {x,y,w,h} }. A purely
//              cosmetic floorplan label (e.g. a closet outline) — never
//              interactive, never has furniture/fixtures. Always sorted to
//              the end of the output array.
//
// GEOMETRY -> DATA MODEL:
//   room:<roomId>               -> room.rect (absolute x/y/w/h read directly)
//   furn:<roomId>:<i>           -> furniture[i], position made room-relative
//   furn:<roomId>:<i>:<k>       -> furniture[i].kids[k], position made
//                                  relative to the PARENT FURNITURE item
//                                  (matches web/src/plan/Furniture.jsx)
//   fixture:<roomId>:<deviceId> -> fixtures[deviceId], room-relative. May be
//                                  backed by MULTIPLE <circle>s (see below).
//
// ILLUSTRATOR ID MANGLING: when a shape is duplicated in Illustrator, the
// duplicate keeps the same visual identity but gets a NEW, uniquified `id`
// (typically the old id with a numeric "-N" suffix tacked on, e.g.
// "room:office" -> "room:office-8"). Illustrator does NOT rewrite
// `inkscape:label`, so that's the channel the user has to communicate real
// intent past the mangling:
//   - IDENTITY PREFERENCE: for any element, this importer prefers
//     `inkscape:label` over `id` when the label itself parses as one of our
//     conventions (room:/furn:/fixture:/closet:/decoration:). This is how a
//     duplicated element can be told apart from a merely-renamed one, and
//     how a new furniture item can be pinned to a clean index (e.g. give a
//     duplicate the label "furn:master:3" instead of living with whatever
//     mangled id "furn:master:2-5" Illustrator produced).
//   - FURNITURE indices tolerate a dash-suffixed digit chain (e.g. "1-9",
//     "2-7-7") as a distinct, valid furniture item — this is exactly what a
//     duplicated furn:<room>:<i> turns into. These are grouped by their
//     full id/label string (not coerced to the base number) so duplicates
//     don't clobber the original; the output array order is the original
//     numeric index ascending, ties broken by document order (so
//     duplicates land right after their sibling).
//   - FIXTURES: a device can appear as more than one <circle>. Identity is
//     `fixture:<roomId>:<deviceId>[:<index>]`, read from inkscape:label
//     when present (the reliable channel), else from `id` with a trailing
//     Illustrator "-N" dup suffix stripped from the device id (only when
//     the suffix is ALL digits, so device ids like "office-bookshelf" or
//     "led-art-wall" are untouched). Positions for the same device are
//     grouped and ordered by `:<index>` ascending (index 1 first); a single
//     position emits `{x,y}`, more than one emits `[{x,y}, ...]`.
//   - DECORATIONS: any element whose inkscape:label starts with "closet:"
//     or "decoration:" is a decoration, never a room — regardless of what
//     its `id` looks like (Illustrator duplication of an existing room rect
//     is exactly how a user creates one, so the id often looks like a
//     mangled room id; the label is what overrides that).
//
// LOSSLESS FIELDS: r, rot, selectable, label, links, and the kids array
// shape are read from data-* attributes on the element. If a data-*
// attribute is missing (e.g. an editor stripped unknown attributes), this
// script falls back to the embedded <metadata id="apollo-rooms-source">
// JSON blob (matched by id) and prints a warning that it did so.
//
// TRANSFORM HANDLING (LIMITATIONS):
//   - `translate(tx,ty)` or a pure-translation `matrix(1,0,0,1,tx,ty)` on a
//     rect/circle itself is supported: the translation is added to that
//     element's position. This covers "I dragged this one shape."
//   - A wrapping `<g transform="rotate(deg cx cy)">` around a rotated
//     furniture item: if the editor preserved the `rotate(...)` function
//     form, the (possibly-changed) angle is read directly and overrides
//     data-rot. Geometry is unaffected either way since our rotate() always
//     carries an explicit center and never touches the child rect's x/y.
//   - If an editor bakes rotation into a `matrix(a,b,c,d,e,f)` with real
//     rotation/scale (not just translation), this script does NOT attempt
//     to decompose it: it applies only the translation component (best
//     effort) and KEEPS the original stashed data-rot, printing a warning
//     asking you to check that item's rotation by hand.
//   - A <g> whose OWN id or inkscape:label identifies it as a furniture or
//     fixture item (furn:<room>:<i> / fixture:<room>:<device>), but which
//     contains NO rect/circle carrying that same identity (e.g. the user
//     replaced the shape with arbitrary artwork, or nested it too deeply
//     for our regex scan to see), has no live geometry to read. This script
//     falls back to the embedded metadata for that exact index if
//     available; if not, it SKIPS the item entirely and prints a warning
//     naming the element so a human can re-add it by hand.
//   - Adding a brand-new ROOM (an id the exporter never emitted, with no
//     recognizable furn:/fixture:/closet:/decoration: label) is NOT
//     supported — add it directly in rooms.json instead.
//
// USAGE:
//   node _scripts/floorplan-import.mjs                     # dry run -> config/rooms.json.imported
//   node _scripts/floorplan-import.mjs path/to/edited.svg
//   node _scripts/floorplan-import.mjs --write              # overwrite config/rooms.json

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import JSON5 from 'json5';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, '..');

const argv = process.argv.slice(2);
function opt(name) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
}
const WRITE = argv.includes('--write');
// first bare (non-flag, non-flag-value) argument is treated as the svg path
const flagsWithValues = new Set(['--svg', '--rooms', '--out']);
let positional = null;
for (let i = 0; i < argv.length; i++) {
  if (flagsWithValues.has(argv[i])) { i++; continue; }
  if (argv[i].startsWith('--')) continue;
  positional = argv[i];
  break;
}

const SVG_FILE = path.resolve(opt('--svg') || positional || path.join(ROOT, 'documentation', 'floorplan-editable.svg'));
const ROOMS_FILE = path.resolve(opt('--rooms') || path.join(ROOT, 'config', 'rooms.json'));
const OUT_FILE = WRITE ? ROOMS_FILE : path.resolve(opt('--out') || `${ROOMS_FILE}.imported`);

function fail(msg) {
  process.stderr.write(`floorplan-import: ${msg}\n`);
  process.exit(1);
}
function warn(msg) {
  process.stderr.write(`floorplan-import: warning: ${msg}\n`);
}

// --- tiny attribute parser for a single self-closing tag's contents ---
function parseAttrs(tagBody) {
  const attrs = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(tagBody))) {
    attrs[m[1]] = m[2].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  }
  return attrs;
}

function num(v, fallback = 0) {
  const f = parseFloat(v);
  return Number.isFinite(f) ? f : fallback;
}

// Parses a transform attribute value into { dx, dy, rotDeg, unsupported }.
// Only handles translate(...) and matrix(...); rotate(...) on the element
// itself (as opposed to a wrapping g) isn't emitted by our exporter and
// isn't decomposed here.
function parseTransform(transform) {
  if (!transform) return { dx: 0, dy: 0, rotDeg: null, unsupported: false };
  const t = transform.trim();
  let m = /^translate\(\s*(-?[\d.eE+-]+)(?:[,\s]+(-?[\d.eE+-]+))?\s*\)$/.exec(t);
  if (m) return { dx: num(m[1]), dy: m[2] !== undefined ? num(m[2]) : 0, rotDeg: null, unsupported: false };
  m = /^matrix\(\s*(-?[\d.eE+-]+)[,\s]+(-?[\d.eE+-]+)[,\s]+(-?[\d.eE+-]+)[,\s]+(-?[\d.eE+-]+)[,\s]+(-?[\d.eE+-]+)[,\s]+(-?[\d.eE+-]+)\s*\)$/.exec(t);
  if (m) {
    const [a, b, c, d, e, f] = m.slice(1).map(Number);
    const isPureTranslation = Math.abs(a - 1) < 1e-6 && Math.abs(d - 1) < 1e-6 && Math.abs(b) < 1e-6 && Math.abs(c) < 1e-6;
    if (isPureTranslation) return { dx: e, dy: f, rotDeg: null, unsupported: false };
    // Real rotation/scale baked in. Best effort: still apply e,f as a
    // translation hint, but flag it as unsupported so the caller keeps the
    // stashed data-rot and warns.
    return { dx: e, dy: f, rotDeg: null, unsupported: true };
  }
  m = /^rotate\(\s*(-?[\d.eE+-]+)(?:[,\s]+(-?[\d.eE+-]+)[,\s]+(-?[\d.eE+-]+))?\s*\)$/.exec(t);
  if (m) return { dx: 0, dy: 0, rotDeg: num(m[1]), unsupported: false };
  return { dx: 0, dy: 0, rotDeg: null, unsupported: true };
}

function readSvg(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    fail(`can't read ${file}: ${e.message}`);
  }
}

// Order-preserving tokenizer: walks <g ...>, </g>, <rect .../>,
// <circle .../>, and <metadata>...</metadata> in document order, maintaining
// a real stack so `enclosingTransform` reflects genuine nesting. Also
// records every <g> element itself (attrs + transform) in `groups`, in
// document order, keyed by nothing in particular — callers filter for the
// ones whose own id/label identify them as a furniture or fixture item.
function reScanWithStack(svgRaw) {
  // Strip XML comments first — our own header comment documents the id
  // conventions using literal <g>/<rect> text, which would otherwise be
  // mistaken for real elements (and its <metadata> mention would send the
  // metadata-block match run away hunting for the next literal
  // </metadata>, swallowing the whole rest of the file).
  const svg = svgRaw.replace(/<!--[\s\S]*?-->/g, '');
  const tokenRe = /<g\b([^>]*)>|<\/g>|<rect\b([^>]*)\/>|<circle\b([^>]*)\/>|<metadata\b[^>]*>[\s\S]*?<\/metadata>/g;
  const elements = [];
  const groups = [];
  const gStack = [];
  let m;
  while ((m = tokenRe.exec(svg))) {
    const full = m[0];
    if (full.startsWith('<metadata')) continue;
    if (full === '</g>') {
      gStack.pop();
      continue;
    }
    if (full.startsWith('<g')) {
      const attrs = parseAttrs(m[1] || '');
      gStack.push(attrs.transform || null);
      groups.push({ attrs, transform: attrs.transform || null });
      continue;
    }
    if (full.startsWith('<rect')) {
      const attrs = parseAttrs(m[2] || '');
      elements.push({ tag: 'rect', attrs, enclosingTransform: gStack.length ? gStack[gStack.length - 1] : null });
      continue;
    }
    if (full.startsWith('<circle')) {
      const attrs = parseAttrs(m[3] || '');
      elements.push({ tag: 'circle', attrs, enclosingTransform: gStack.length ? gStack[gStack.length - 1] : null });
      continue;
    }
  }
  return { elements, groups };
}

function readMetadataFallback(svgRaw) {
  const svg = svgRaw.replace(/<!--[\s\S]*?-->/g, '');
  const m = /<metadata\b[^>]*id="apollo-rooms-source"[^>]*>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/metadata>/.exec(svg);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch (e) {
    warn(`embedded metadata blob failed to parse (${e.message}); no fallback available`);
    return null;
  }
}

function metadataLookup(fallbackRooms) {
  const roomsById = new Map();
  if (!fallbackRooms) return { room: () => null, furniture: () => null, kid: () => null };
  for (const r of fallbackRooms) roomsById.set(r.id, r);
  return {
    room: (roomId) => roomsById.get(roomId) || null,
    furniture: (roomId, idx) => roomsById.get(roomId)?.furniture?.[idx] || null,
    kid: (roomId, idx, kidIdx) => roomsById.get(roomId)?.furniture?.[idx]?.kids?.[kidIdx] || null,
  };
}

// --- identity resolution: inkscape:label preferred, id as fallback -------
//
// A single regex covers both `furn:<room>:<idx>` and its kid form
// `furn:<room>:<idx>:<kidIdx>`. <idx>/<kidIdx> tolerate a dash-suffixed
// digit chain (e.g. "1-9", "2-7-7") because that's exactly what Illustrator
// produces when a furn:<room>:<idx> item is duplicated — the duplicate is a
// genuinely distinct furniture item, not a rename of the original, so it's
// kept as its own key rather than being coerced to a bare number.
const FURN_RE = /^furn:([^:]+):([0-9]+(?:-[0-9]+)*)(?::([0-9]+(?:-[0-9]+)*))?$/;

function furnIdentity(el) {
  const label = el.attrs['inkscape:label'];
  if (label) {
    const m = FURN_RE.exec(label);
    if (m) return { roomId: m[1], idxKey: m[2], kidKey: m[3] || null };
  }
  const id = el.attrs.id;
  if (id) {
    const m = FURN_RE.exec(id);
    if (m) return { roomId: m[1], idxKey: m[2], kidKey: m[3] || null };
  }
  return null;
}

// Same idea for fixtures, but the identity string carries the device id
// directly (not a bare number), plus an optional `:<index>` for
// multi-position devices. `fixture:<room>:<device>:<index>` is the
// canonical form (reliable only via inkscape:label, since it's a 3rd colon
// segment an `id` fallback can't tell apart from a device id containing a
// colon). The `id` fallback strips a trailing Illustrator "-N" dup suffix
// from the device id — but ONLY when the suffix is purely digits, so real
// hyphenated device ids like "office-bookshelf" or "led-art-wall" are left
// alone.
const FIXTURE_LABEL_RE = /^fixture:([^:]+):(.+):([0-9]+)$/;
const FIXTURE_ID_RE = /^fixture:([^:]+):(.+)$/;
const TRAILING_NUMERIC_DUP_RE = /^(.*)-([0-9]+)$/;

function fixtureIdentity(el) {
  const label = el.attrs['inkscape:label'];
  if (label) {
    let m = FIXTURE_LABEL_RE.exec(label);
    if (m) return { roomId: m[1], deviceId: m[2], index: Number(m[3]) };
    m = FIXTURE_ID_RE.exec(label);
    if (m) return { roomId: m[1], deviceId: m[2], index: null };
  }
  const id = el.attrs.id;
  if (id) {
    const m = FIXTURE_ID_RE.exec(id);
    if (m) {
      let deviceId = m[2];
      const dup = TRAILING_NUMERIC_DUP_RE.exec(deviceId);
      if (dup) deviceId = dup[1];
      return { roomId: m[1], deviceId, index: null };
    }
  }
  return null;
}

// Any element (in practice: a room-shaped rect the user duplicated and
// relabeled) whose inkscape:label starts with "closet:" or "decoration:" is
// a decoration, not a room — regardless of its id.
function decorationLabel(el) {
  const label = el.attrs['inkscape:label'];
  if (label && /^(?:closet|decoration):.+$/.test(label)) return label;
  return null;
}

function decorationFromLabel(label, rect) {
  const m = /^(closet|decoration):(.+)$/.exec(label);
  const kind = m[1];
  const rest = m[2];
  const slug = `${kind}-${rest
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-+|-+$)/g, '')}`;
  const title = rest
    .replace(/[-_]+/g, ' ')
    .trim()
    .split(/\s+/)
    .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w))
    .join(' ');
  return { id: slug, label: title, decorative: true, rect };
}

// Groups a furniture/kid Map's string keys ("0", "1-9", "2-7-7", ...) into
// output order: ascending by the leading numeric index, ties broken by
// original (document/insertion) order — Array.prototype.sort is stable, and
// Map iteration order is insertion order, so this is enough to put
// duplicates right after the sibling they were duplicated from.
function baseIdx(key) {
  return parseInt(key.split('-')[0], 10);
}
function orderedKeys(map) {
  return [...map.keys()].sort((a, b) => baseIdx(a) - baseIdx(b));
}

function main() {
  const svg = readSvg(SVG_FILE);
  const fallbackRooms = readMetadataFallback(svg);
  const lookup = metadataLookup(fallbackRooms);
  const { elements, groups } = reScanWithStack(svg);

  // --- absolute position of each element, with transform applied ---
  function absPos(el) {
    if (el.tag === 'rect') {
      let x = num(el.attrs.x);
      let y = num(el.attrs.y);
      const w = num(el.attrs.width);
      const h = num(el.attrs.height);
      const ownT = parseTransform(el.attrs.transform);
      x += ownT.dx;
      y += ownT.dy;
      let rotOverride = null;
      let rotUnsupportedWarning = false;
      if (el.enclosingTransform) {
        const gT = parseTransform(el.enclosingTransform);
        // our exporter's rotate(deg cx cy) is cosmetic-only for rect x/y
        // (rotation happens around an explicit point, doesn't rewrite the
        // child's x/y attribute) so we only need to react to it if the
        // angle itself changed, or if it got flattened into a matrix.
        if (gT.rotDeg !== null) rotOverride = `${gT.rotDeg}deg`;
        else if (gT.unsupported) rotUnsupportedWarning = true;
        else {
          x += gT.dx;
          y += gT.dy;
        }
      }
      return { x, y, w, h, rotOverride, rotUnsupportedWarning };
    }
    // circle
    let cx = num(el.attrs.cx);
    let cy = num(el.attrs.cy);
    const ownT = parseTransform(el.attrs.transform);
    cx += ownT.dx;
    cy += ownT.dy;
    if (el.enclosingTransform) {
      const gT = parseTransform(el.enclosingTransform);
      if (!gT.unsupported && gT.rotDeg === null) {
        cx += gT.dx;
        cy += gT.dy;
      }
    }
    return { x: cx, y: cy };
  }

  const roomIdRe = /^room:(.+)$/;

  const roomsById = new Map(); // roomId -> { rect, label, selectable, links, order }
  const decorations = []; // { id, label, decorative, rect }, in document order
  const furnByRoom = new Map(); // roomId -> Map(idxKey -> {x,y,w,h,r,rot})
  const kidsByRoom = new Map(); // roomId -> Map(idxKey -> Map(kidKey -> {x,y,w,h,r}))
  const fixturesByRoom = new Map(); // roomId -> Map(deviceId -> [{x,y,index}])

  let roomOrder = 0;
  for (const el of elements) {
    const id = el.attrs.id;

    if (el.tag === 'rect') {
      const decLabel = decorationLabel(el);
      if (decLabel) {
        const pos = absPos(el);
        decorations.push(decorationFromLabel(decLabel, { x: round(pos.x), y: round(pos.y), w: round(pos.w), h: round(pos.h) }));
        continue;
      }

      const fi = furnIdentity(el);
      if (fi && fi.kidKey != null) {
        const { roomId, idxKey, kidKey } = fi;
        const pos = absPos(el);
        let r = el.attrs['data-r'];
        if (r === undefined) {
          const fb = lookup.kid(roomId, Number(idxKey), Number(kidKey));
          if (fb) { r = fb.r; warn(`furn:${roomId}:${idxKey}:${kidKey} missing data-r, recovered from embedded metadata`); }
        }
        if (!kidsByRoom.has(roomId)) kidsByRoom.set(roomId, new Map());
        const byIdx = kidsByRoom.get(roomId);
        if (!byIdx.has(idxKey)) byIdx.set(idxKey, new Map());
        byIdx.get(idxKey).set(kidKey, { x: pos.x, y: pos.y, w: pos.w, h: pos.h, r });
        continue;
      }

      if (fi) {
        const { roomId, idxKey } = fi;
        const pos = absPos(el);
        let r = el.attrs['data-r'];
        let rot = el.attrs['data-rot'];
        if (pos.rotOverride) rot = pos.rotOverride;
        if (pos.rotUnsupportedWarning) {
          warn(`furn:${roomId}:${idxKey} has an enclosing transform with rotation/scale baked into a matrix — keeping stashed rotation (${rot ?? 'none'}) and applying its translation component only; please verify this item's rotation by hand`);
        }
        if (r === undefined) {
          const fb = lookup.furniture(roomId, Number(idxKey));
          if (fb) { r = fb.r; warn(`furn:${roomId}:${idxKey} missing data-r, recovered from embedded metadata`); }
        }
        if (rot === undefined) {
          const fb = lookup.furniture(roomId, Number(idxKey));
          if (fb && fb.rot != null) { rot = fb.rot; warn(`furn:${roomId}:${idxKey} missing data-rot, recovered from embedded metadata`); }
        }
        if (!furnByRoom.has(roomId)) furnByRoom.set(roomId, new Map());
        furnByRoom.get(roomId).set(idxKey, { x: pos.x, y: pos.y, w: pos.w, h: pos.h, r, rot });
        continue;
      }

      if (id && roomIdRe.test(id)) {
        const roomId = roomIdRe.exec(id)[1];
        const pos = absPos(el);
        let label = el.attrs['data-label'];
        let selectableAttr = el.attrs['data-selectable'];
        let linksAttr = el.attrs['data-links'];
        if (label === undefined) {
          const fb = lookup.room(roomId);
          if (fb) { label = fb.label; warn(`room:${roomId} missing data-label, recovered from embedded metadata`); }
        }
        if (selectableAttr === undefined) {
          const fb = lookup.room(roomId);
          if (fb) { selectableAttr = String(fb.selectable !== false); warn(`room:${roomId} missing data-selectable, recovered from embedded metadata`); }
        }
        let links;
        if (linksAttr) {
          links = linksAttr.split(',').map((s) => s.trim()).filter(Boolean);
        } else {
          const fb = lookup.room(roomId);
          if (fb && Array.isArray(fb.links) && fb.links.length) links = fb.links.slice();
        }
        roomsById.set(roomId, {
          id: roomId,
          label: label !== undefined ? label : roomId,
          selectable: selectableAttr !== undefined ? selectableAttr === 'true' : true,
          rect: { x: pos.x, y: pos.y, w: pos.w, h: pos.h },
          links,
          order: roomOrder++,
        });
        continue;
      }

      // unrecognized rect (e.g. plane-bounds guide) — ignore
      continue;
    }

    // circle
    const fx = fixtureIdentity(el);
    if (fx) {
      const pos = absPos(el);
      if (!fixturesByRoom.has(fx.roomId)) fixturesByRoom.set(fx.roomId, new Map());
      const byDevice = fixturesByRoom.get(fx.roomId);
      if (!byDevice.has(fx.deviceId)) byDevice.set(fx.deviceId, []);
      byDevice.get(fx.deviceId).push({ x: pos.x, y: pos.y, index: fx.index });
    }
  }

  if (roomsById.size === 0) fail(`no room:<id> rects found in ${SVG_FILE} — is this a file generated by floorplan-export.mjs?`);

  // --- cross-check: a <g> that identifies itself (via id/label) as a
  // furniture or fixture item, but has no rect/circle inside carrying that
  // same identity, has no live geometry we can read. Fall back to the
  // embedded metadata for that exact index; if that's not available either,
  // skip the item and warn so a human knows to re-add it. ---
  for (const g of groups) {
    const label = g.attrs['inkscape:label'];
    const gid = g.attrs.id;
    const source = label || gid;
    if (!source) continue;

    const furnMatch = FURN_RE.exec(source);
    if (furnMatch && furnMatch[3] == null) {
      const roomId = furnMatch[1];
      const idxKey = furnMatch[2];
      const alreadyResolved = furnByRoom.get(roomId)?.has(idxKey);
      if (alreadyResolved) continue; // normal cosmetic wrapper around a matching rect
      const gT = parseTransform(g.transform);
      const fb = lookup.furniture(roomId, Number(idxKey));
      const room = roomsById.get(roomId);
      if (fb && room) {
        warn(`furn:${roomId}:${idxKey} (element id="${gid ?? '?'}") has no rect/circle geometry inside its group — recovering position/size entirely from embedded metadata (plus this group's translation); please verify by hand`);
        if (!furnByRoom.has(roomId)) furnByRoom.set(roomId, new Map());
        furnByRoom.get(roomId).set(idxKey, {
          x: room.rect.x + fb.x + gT.dx,
          y: room.rect.y + fb.y + gT.dy,
          w: fb.w,
          h: fb.h,
          r: fb.r,
          rot: fb.rot,
        });
      } else {
        const reason = gT.unsupported
          ? `its transform also bakes real rotation/scale into a matrix (${g.transform})`
          : 'no embedded metadata fallback exists for that index either';
        warn(`furn:${roomId}:${idxKey} (element id="${gid ?? '?'}"): no rect/circle geometry found inside the group (only non-rect content), and ${reason} — skipping this furniture item; please re-add it by hand and verify its position/rotation`);
      }
      continue;
    }

    const fixtureMatch = FIXTURE_ID_RE.exec(source);
    if (fixtureMatch) {
      const roomId = fixtureMatch[1];
      const deviceId = fixtureMatch[2].replace(/:[0-9]+$/, '');
      const already = fixturesByRoom.get(roomId)?.has(deviceId);
      if (already) continue;
      warn(`fixture:${roomId}:${deviceId} (element id="${gid ?? '?'}"): no circle geometry found inside the group — skipping this fixture position; please re-add it by hand`);
    }
  }

  // --- assemble rooms.json shape, making furniture/fixtures room-relative ---
  const rooms = [...roomsById.values()]
    .sort((a, b) => a.order - b.order)
    .map((room) => {
      const out = {
        id: room.id,
        label: room.label,
        selectable: room.selectable,
        rect: { x: round(room.rect.x), y: round(room.rect.y), w: round(room.rect.w), h: round(room.rect.h) },
      };

      const furnMap = furnByRoom.get(room.id);
      const furniture = [];
      if (furnMap) {
        for (const idxKey of orderedKeys(furnMap)) {
          const f = furnMap.get(idxKey);
          const item = {
            x: round(f.x - room.rect.x),
            y: round(f.y - room.rect.y),
            w: round(f.w),
            h: round(f.h),
            r: f.r,
          };
          if (f.rot != null) item.rot = f.rot;
          const kidMap = kidsByRoom.get(room.id)?.get(idxKey);
          if (kidMap) {
            item.kids = orderedKeys(kidMap).map((ki) => {
              const k = kidMap.get(ki);
              return {
                x: round(k.x - f.x),
                y: round(k.y - f.y),
                w: round(k.w),
                h: round(k.h),
                r: k.r,
              };
            });
          }
          furniture.push(item);
        }
      }
      if (furniture.length || (Array.isArray(lookup.room(room.id)?.furniture) && lookup.room(room.id).furniture.length)) {
        out.furniture = furniture;
      }

      const fixMap = fixturesByRoom.get(room.id);
      const fixtures = {};
      if (fixMap) {
        for (const [deviceId, positions] of fixMap.entries()) {
          const sorted = positions.slice().sort((a, b) => {
            const ai = a.index == null ? 0 : a.index;
            const bi = b.index == null ? 0 : b.index;
            return ai - bi;
          });
          const rel = sorted.map((p) => ({ x: round(p.x - room.rect.x), y: round(p.y - room.rect.y) }));
          fixtures[deviceId] = rel.length > 1 ? rel : rel[0];
        }
      }
      out.fixtures = fixtures;

      if (room.links && room.links.length) out.links = room.links;

      return out;
    });

  const combined = [...rooms, ...decorations];
  const rendered = JSON5.stringify(combined, { space: 2, quote: '"' });

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, rendered + '\n', 'utf8');

  // --- diff summary against the current rooms.json, if present ---
  let summary = `floorplan-import: wrote ${path.relative(ROOT, OUT_FILE)} (${rooms.length} rooms, ${decorations.length} decorations)`;
  if (fs.existsSync(ROOMS_FILE)) {
    try {
      const before = JSON5.parse(fs.readFileSync(ROOMS_FILE, 'utf8'));
      summary += '\n' + diffSummary(before, combined);
    } catch (e) {
      warn(`couldn't parse ${ROOMS_FILE} for a diff summary: ${e.message}`);
    }
  }
  process.stdout.write(summary + '\n');
  if (!WRITE) {
    process.stdout.write(`floorplan-import: dry run — nothing written to ${path.relative(ROOT, ROOMS_FILE)}. Re-run with --write to apply.\n`);
  }
}

function round(n) {
  const r = Math.round(n * 1000) / 1000;
  return Object.is(r, -0) ? 0 : r;
}

function diffSummary(before, after) {
  const beforeById = new Map(before.map((r) => [r.id, r]));
  const afterById = new Map(after.map((r) => [r.id, r]));
  const lines = [];
  for (const id of new Set([...beforeById.keys(), ...afterById.keys()])) {
    const b = beforeById.get(id);
    const a = afterById.get(id);
    const kind = (a && a.decorative) || (b && b.decorative) ? 'decoration' : 'room';
    if (!b) { lines.push(`  + ${kind} ${id} (new)`); continue; }
    if (!a) { lines.push(`  - ${kind} ${id} (removed)`); continue; }
    const changes = [];
    if (JSON.stringify(b.rect) !== JSON.stringify(a.rect)) {
      changes.push(`rect ${JSON.stringify(b.rect)} -> ${JSON.stringify(a.rect)}`);
    }
    const bf = b.furniture || [], af = a.furniture || [];
    if (bf.length !== af.length) changes.push(`furniture count ${bf.length} -> ${af.length}`);
    else {
      bf.forEach((item, i) => {
        if (JSON.stringify(item) !== JSON.stringify(af[i])) changes.push(`furniture[${i}] changed`);
      });
    }
    const bfix = b.fixtures || {}, afix = a.fixtures || {};
    for (const dev of new Set([...Object.keys(bfix), ...Object.keys(afix)])) {
      if (JSON.stringify(bfix[dev]) !== JSON.stringify(afix[dev])) {
        changes.push(`fixture ${dev} ${JSON.stringify(bfix[dev])} -> ${JSON.stringify(afix[dev])}`);
      }
    }
    if (changes.length) lines.push(`  ~ ${kind} ${id}: ${changes.join('; ')}`);
  }
  return lines.length ? `diff vs ${path.relative(ROOT, ROOMS_FILE)}:\n${lines.join('\n')}` : `diff vs ${path.relative(ROOT, ROOMS_FILE)}: no semantic changes`;
}

main();
