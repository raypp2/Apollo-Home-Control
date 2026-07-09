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
// GEOMETRY -> DATA MODEL:
//   room:<roomId>               -> room.rect (absolute x/y/w/h read directly)
//   furn:<roomId>:<i>           -> furniture[i], position made room-relative
//   furn:<roomId>:<i>:<k>       -> furniture[i].kids[k], position made
//                                  relative to the PARENT FURNITURE item
//                                  (matches web/src/plan/Furniture.jsx)
//   fixture:<roomId>:<deviceId> -> fixtures[deviceId], room-relative
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
//     asking you to check that item's rotation by hand. Illustrator/
//     Inkscape usually only do this if you grab the rotate handle directly
//     (not for a plain drag), so this only bites if you rotate.
//   - Adding brand-new rooms/furniture/fixtures (ids the exporter never
//     emitted) is NOT supported — only edits/deletions of existing ids are
//     read. Add new entries directly in rooms.json instead.
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
// a real stack so `enclosingTransform` reflects genuine nesting.
function reScanWithStack(svgRaw) {
  // Strip XML comments first — our own header comment documents the id
  // conventions using literal <g>/<rect> text, which would otherwise be
  // mistaken for real elements (and its <metadata> mention would send the
  // metadata-block match run away hunting for the next literal
  // </metadata>, swallowing the whole rest of the file).
  const svg = svgRaw.replace(/<!--[\s\S]*?-->/g, '');
  const tokenRe = /<g\b([^>]*)>|<\/g>|<rect\b([^>]*)\/>|<circle\b([^>]*)\/>|<metadata\b[^>]*>[\s\S]*?<\/metadata>/g;
  const elements = [];
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
  return elements;
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
  if (!fallbackRooms) return { room: () => null, furniture: () => null, fixture: () => null };
  for (const r of fallbackRooms) roomsById.set(r.id, r);
  return {
    room: (roomId) => roomsById.get(roomId) || null,
    furniture: (roomId, idx) => roomsById.get(roomId)?.furniture?.[idx] || null,
    kid: (roomId, idx, kidIdx) => roomsById.get(roomId)?.furniture?.[idx]?.kids?.[kidIdx] || null,
  };
}

function main() {
  const svg = readSvg(SVG_FILE);
  const fallbackRooms = readMetadataFallback(svg);
  const lookup = metadataLookup(fallbackRooms);
  const elements = reScanWithStack(svg);

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
  const furnRe = /^furn:([^:]+):(\d+)$/;
  const kidRe = /^furn:([^:]+):(\d+):(\d+)$/;
  const fixtureRe = /^fixture:([^:]+):(.+)$/;

  const roomsById = new Map(); // roomId -> { rect, label, selectable, links, order }
  const furnByRoom = new Map(); // roomId -> Map(idx -> {abs, r, rot})
  const kidsByRoom = new Map(); // roomId -> Map(idx -> Map(kidIdx -> {abs, r}))
  const fixturesByRoom = new Map(); // roomId -> Map(deviceId -> {abs})

  let roomOrder = 0;
  for (const el of elements) {
    const id = el.attrs.id;
    if (!id) continue;

    let m;
    if (el.tag === 'rect' && (m = roomIdRe.exec(id)) && !furnRe.test(id) && !kidRe.exec(id)) {
      const roomId = m[1];
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

    if (el.tag === 'rect' && (m = kidRe.exec(id))) {
      const [, roomId, idxStr, kidIdxStr] = m;
      const idx = Number(idxStr);
      const kidIdx = Number(kidIdxStr);
      const pos = absPos(el);
      let r = el.attrs['data-r'];
      if (r === undefined) {
        const fb = lookup.kid(roomId, idx, kidIdx);
        if (fb) { r = fb.r; warn(`${id} missing data-r, recovered from embedded metadata`); }
      }
      if (!kidsByRoom.has(roomId)) kidsByRoom.set(roomId, new Map());
      const byIdx = kidsByRoom.get(roomId);
      if (!byIdx.has(idx)) byIdx.set(idx, new Map());
      byIdx.get(idx).set(kidIdx, { x: pos.x, y: pos.y, w: pos.w, h: pos.h, r });
      continue;
    }

    if (el.tag === 'rect' && (m = furnRe.exec(id))) {
      const [, roomId, idxStr] = m;
      const idx = Number(idxStr);
      const pos = absPos(el);
      let r = el.attrs['data-r'];
      let rot = el.attrs['data-rot'];
      if (pos.rotOverride) rot = pos.rotOverride;
      if (pos.rotUnsupportedWarning) {
        warn(`furn:${roomId}:${idx} has an enclosing transform with rotation/scale baked into a matrix — keeping stashed rotation (${rot ?? 'none'}) and applying its translation component only; please verify this item's rotation by hand`);
      }
      if (r === undefined) {
        const fb = lookup.furniture(roomId, idx);
        if (fb) { r = fb.r; warn(`furn:${roomId}:${idx} missing data-r, recovered from embedded metadata`); }
      }
      if (rot === undefined) {
        const fb = lookup.furniture(roomId, idx);
        if (fb && fb.rot != null) { rot = fb.rot; warn(`furn:${roomId}:${idx} missing data-rot, recovered from embedded metadata`); }
      }
      if (!furnByRoom.has(roomId)) furnByRoom.set(roomId, new Map());
      furnByRoom.get(roomId).set(idx, { x: pos.x, y: pos.y, w: pos.w, h: pos.h, r, rot });
      continue;
    }

    if (el.tag === 'circle' && (m = fixtureRe.exec(id))) {
      const [, roomId, deviceId] = m;
      const pos = absPos(el);
      if (!fixturesByRoom.has(roomId)) fixturesByRoom.set(roomId, new Map());
      fixturesByRoom.get(roomId).set(deviceId, { x: pos.x, y: pos.y });
      continue;
    }
  }

  if (roomsById.size === 0) fail(`no room:<id> rects found in ${SVG_FILE} — is this a file generated by floorplan-export.mjs?`);

  // --- assemble rooms.json shape, making furniture/fixtures room-relative ---
  const rooms = [...roomsById.values()]
    .sort((a, b) => a.order - b.order)
    .map((room) => {
      const out = {
        id: room.id,
        label: room.label,
        selectable: room.selectable,
        rect: { x: room.rect.x, y: room.rect.y, w: room.rect.w, h: room.rect.h },
      };

      const furnMap = furnByRoom.get(room.id);
      const furniture = [];
      if (furnMap) {
        const indices = [...furnMap.keys()].sort((a, b) => a - b);
        for (const idx of indices) {
          const f = furnMap.get(idx);
          const item = {
            x: round(f.x - room.rect.x),
            y: round(f.y - room.rect.y),
            w: round(f.w),
            h: round(f.h),
            r: f.r,
          };
          if (f.rot != null) item.rot = f.rot;
          const kidMap = kidsByRoom.get(room.id)?.get(idx);
          if (kidMap) {
            const kidIndices = [...kidMap.keys()].sort((a, b) => a - b);
            item.kids = kidIndices.map((ki) => {
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
        for (const [deviceId, pos] of fixMap.entries()) {
          fixtures[deviceId] = { x: round(pos.x - room.rect.x), y: round(pos.y - room.rect.y) };
        }
      }
      out.fixtures = fixtures;

      if (room.links && room.links.length) out.links = room.links;

      return out;
    });

  const rendered = JSON5.stringify(rooms, { space: 2, quote: '"' });

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, rendered + '\n', 'utf8');

  // --- diff summary against the current rooms.json, if present ---
  let summary = `floorplan-import: wrote ${path.relative(ROOT, OUT_FILE)} (${rooms.length} rooms)`;
  if (fs.existsSync(ROOMS_FILE)) {
    try {
      const before = JSON5.parse(fs.readFileSync(ROOMS_FILE, 'utf8'));
      summary += '\n' + diffSummary(before, rooms);
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
    if (!b) { lines.push(`  + room ${id} (new)`); continue; }
    if (!a) { lines.push(`  - room ${id} (removed)`); continue; }
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
    if (changes.length) lines.push(`  ~ room ${id}: ${changes.join('; ')}`);
  }
  return lines.length ? `diff vs ${path.relative(ROOT, ROOMS_FILE)}:\n${lines.join('\n')}` : `diff vs ${path.relative(ROOT, ROOMS_FILE)}: no semantic changes`;
}

main();
