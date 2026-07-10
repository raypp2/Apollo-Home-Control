#!/usr/bin/env node
// floorplan-export.mjs — render config/rooms.json as a layered, editable SVG
// so the isometric floorplan's room/furniture/fixture placements can be
// nudged visually in Illustrator (or Inkscape) instead of hand-editing pixel
// coordinates in JSON5.
//
// WHY: rooms.json positions everything in a flat 470x980 top-down plane
// (the isometric renderer's pre-transform coordinate space — see
// web/src/plan/Room.jsx / Furniture.jsx). That plane maps 1:1 onto a plain
// SVG canvas of the same size, so "open in a vector editor" is a legitimate
// way to eyeball and adjust the layout instead of guessing x/y by hand.
//
// PAIRS WITH: _scripts/floorplan-import.mjs, which reads the edited SVG back
// and reconstructs rooms.json.
//
// ID CONVENTIONS (also documented in the generated SVG's header comment):
//   room:<roomId>                  — room rect (absolute position = rect)
//   furn:<roomId>:<i>              — furniture item i (absolute position)
//   furn:<roomId>:<i>:<k>          — kid k of furniture item i (absolute
//                                    position; kid coords in rooms.json are
//                                    relative to the PARENT FURNITURE item,
//                                    not the room — see Furniture.jsx)
//   fixture:<roomId>:<deviceId>    — fixture dot (absolute position). A
//                                    device with more than one position
//                                    (rooms.json fixtures[device] is an
//                                    array) emits one <circle> per position:
//                                    the first is plain "fixture:room:device"
//                                    with inkscape:label "...:1", the rest
//                                    get a "-2", "-3", ... id suffix and a
//                                    matching ":2", ":3", ... label.
//   decoration:<slug>              — a cosmetic-only rect (rooms.json entry
//                                    with decorative:true, e.g. a closet
//                                    outline), in its own "decorations"
//                                    layer. inkscape:label is set to
//                                    "closet:<rest>" / "decoration:<rest>"
//                                    (the slug with its first "-" turned
//                                    back into ":"), which is what the
//                                    importer actually keys off of.
//
// LOSSLESSNESS: SVG rect/circle geometry only carries x/y/w/h. Fields the
// data model has that SVG doesn't (complex CSS radius strings, `rot`,
// `selectable`, `label`, `links`, the kids array shape) are stashed on the
// element itself as `data-*` attributes, which is the primary channel the
// importer reads. As a second-line fallback (in case an editor round-trip
// strips unknown attributes), the ENTIRE parsed source is also embedded
// verbatim as a JSON blob in a hidden <metadata> element; the importer only
// consults it when a `data-*` value is missing from its element.
//
// USAGE:
//   node _scripts/floorplan-export.mjs
//   node _scripts/floorplan-export.mjs --rooms config/rooms.json --out documentation/floorplan-editable.svg

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

const ROOMS_FILE = path.resolve(opt('--rooms') || path.join(ROOT, 'config', 'rooms.json'));
const OUT_FILE = path.resolve(opt('--out') || path.join(ROOT, 'documentation', 'floorplan-editable.svg'));

const PLANE_W = 470;
const PLANE_H = 980;

function fail(msg) {
  process.stderr.write(`floorplan-export: ${msg}\n`);
  process.exit(1);
}

function num(n) {
  if (!Number.isFinite(n)) return '0';
  const r = Math.round(n * 1000) / 1000;
  return Number.isInteger(r) ? String(r) : String(r).replace(/0+$/, '').replace(/\.$/, '');
}

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// A CSS radius string maps cleanly onto SVG rx/ry when it's a single plain
// number + px/% (e.g. "2px", "50%"). Anything else (space-separated corners,
// "/" elliptical syntax) can't be expressed as rx/ry, so we draw a plain
// rect and rely entirely on the stashed data-r attribute to round-trip it.
function simpleRadius(r) {
  if (r == null) return null;
  const m = /^\s*(-?[\d.]+)(px|%)\s*$/.exec(String(r));
  if (!m) return null;
  return { value: parseFloat(m[1]), unit: m[2] };
}

function parseRotDeg(rot) {
  if (rot == null) return null;
  const m = /(-?[\d.]+)\s*deg/.exec(String(rot));
  if (m) return parseFloat(m[1]);
  const f = parseFloat(rot);
  return Number.isFinite(f) ? f : null;
}

function readRooms(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    fail(`can't read ${file}: ${e.message}`);
  }
  let data;
  try {
    data = JSON5.parse(raw);
  } catch (e) {
    fail(`can't parse ${file} as JSON5: ${e.message}`);
  }
  if (!Array.isArray(data)) fail(`${file} must be a JSON5 array of rooms`);
  return data;
}

function rectAttrs({ x, y, w, h, id, dataAttrs = {}, extraAttrs = '', radius }) {
  const parts = [`id="${esc(id)}"`, `x="${num(x)}"`, `y="${num(y)}"`, `width="${num(w)}"`, `height="${num(h)}"`];
  if (radius) {
    parts.push(`rx="${radius.value}${radius.unit === '%' ? '%' : ''}"`, `ry="${radius.value}${radius.unit === '%' ? '%' : ''}"`);
  }
  for (const [k, v] of Object.entries(dataAttrs)) {
    if (v === undefined || v === null || v === '') continue;
    parts.push(`data-${k}="${esc(v)}"`);
  }
  if (extraAttrs) parts.push(extraAttrs);
  return parts.join(' ');
}

function buildFurnitureRect(roomId, idx, kidIdx, item, absX, absY) {
  const id = kidIdx == null ? `furn:${roomId}:${idx}` : `furn:${roomId}:${idx}:${kidIdx}`;
  const radius = simpleRadius(item.r);
  const dataAttrs = {
    r: item.r != null ? String(item.r) : undefined,
    rot: kidIdx == null && item.rot != null ? String(item.rot) : undefined,
  };
  const cls = kidIdx == null ? 'furn' : 'furn-kid';
  const style = kidIdx == null
    ? 'fill:rgba(120,170,220,0.18);stroke:#3d6ea5;stroke-width:1'
    : 'fill:rgba(120,170,220,0.32);stroke:#3d6ea5;stroke-width:0.75';
  const attrs = rectAttrs({ x: absX, y: absY, w: item.w, h: item.h, id, dataAttrs, radius, extraAttrs: `class="${cls}" style="${style}"` });
  return `      <rect ${attrs} />`;
}

function main() {
  const rooms = readRooms(ROOMS_FILE);

  const lines = [];
  lines.push('<?xml version="1.0" encoding="UTF-8" standalone="no"?>');
  lines.push(
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
    `xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" ` +
    `xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.0.dtd" ` +
    `width="${PLANE_W}" height="${PLANE_H}" viewBox="0 0 ${PLANE_W} ${PLANE_H}" ` +
    `data-apollo-floorplan="1">`
  );

  lines.push(`  <!--
    Apollo dashboard floorplan — editable export. Generated by
    _scripts/floorplan-export.mjs from config/rooms.json. Round-trips back
    via _scripts/floorplan-import.mjs.

    Coordinate space: 470x980 flat plane (matches rooms.json exactly,
    BEFORE the isometric 3D transform the live dashboard applies).

    Edit by MOVING/RESIZING elements. Do not rename ids or you'll break the
    mapping back to rooms.json. Layers (top-level <g id="...">):
      guides      - locked reference outline, not imported
      rooms       - one <rect id="room:<roomId>"> + label <text> per room
      decorations - one <rect id="decoration:<slug>"> per cosmetic-only
                    entry (e.g. a closet outline), inkscape:label
                    "closet:<rest>" / "decoration:<rest>" — never a room,
                    never has furniture/fixtures
      furniture   - one <rect id="furn:<roomId>:<i>"> per item, optionally
                    wrapped in <g transform="rotate(deg cx cy)"> when the
                    item has a rot; kids are <rect id="furn:<roomId>:<i>:<k>">
      fixtures    - one <circle id="fixture:<roomId>:<deviceId>"> + label
                    per device dot. A device with more than one position
                    gets one circle per position: the first plain, the rest
                    id-suffixed "-2", "-3", ... with inkscape:label
                    "fixture:<roomId>:<deviceId>:<index>" (index 1 first).

    All positions are ABSOLUTE on the 470x980 canvas (rooms.json stores
    furniture/fixtures relative to their room's rect — this export bakes
    that offset in; the importer subtracts it back out).

    ILLUSTRATOR NOTE: duplicating an element gives the duplicate a NEW id
    (often the old id + a "-N" suffix) but keeps inkscape:label untouched.
    The importer prefers inkscape:label over id for exactly this reason —
    set/fix the label if you want a duplicated item's true identity to
    survive an id Illustrator mangled.

    Fields the SVG geometry can't hold (complex CSS radius strings, rot,
    selectable, room label, links, non-simple furniture radii) are
    stashed as data-* attributes on the relevant element, e.g. data-r,
    data-rot, data-selectable, data-label, data-links. A full JSON copy of
    the source is also embedded in the hidden <metadata> block below as a
    fallback if an editor strips unknown attributes.

    Import: node _scripts/floorplan-import.mjs [svg-file] [--write]
  -->`);

  // --- guides layer (locked bounds reference) ---
  lines.push(`  <g id="guides" inkscape:label="guides" inkscape:groupmode="layer" sodipodi:insensitive="true" style="pointer-events:none">`);
  lines.push(`    <rect id="plane-bounds" x="0" y="0" width="${PLANE_W}" height="${PLANE_H}" fill="none" stroke="#999999" stroke-width="1" stroke-dasharray="4 3" />`);
  lines.push(`  </g>`);

  // --- rooms layer (decorations render in their own layer below) ---
  lines.push(`  <g id="rooms" inkscape:label="rooms" inkscape:groupmode="layer">`);
  for (const room of rooms) {
    if (room.decorative) continue;
    const { id, label, selectable, rect, links } = room;
    if (!rect) continue;
    const isSelectable = selectable !== false;
    const dataAttrs = {
      label,
      selectable: String(selectable !== undefined ? !!selectable : true),
      links: Array.isArray(links) && links.length ? links.join(',') : undefined,
    };
    const style = isSelectable
      ? 'fill:rgba(234,229,239,0.06);stroke:#7a6ea0;stroke-width:1.5'
      : 'fill:rgba(234,229,239,0.03);stroke:#a08e7a;stroke-width:1.5;stroke-dasharray:6 4';
    const attrs = rectAttrs({
      x: rect.x, y: rect.y, w: rect.w, h: rect.h,
      id: `room:${id}`,
      dataAttrs,
      extraAttrs: `class="room ${isSelectable ? 'room--selectable' : 'room--fixed'}" style="${style}"`,
    });
    lines.push(`    <rect ${attrs} />`);
    lines.push(`    <text x="${num(rect.x + 6)}" y="${num(rect.y + 15)}" font-size="11" font-family="sans-serif" fill="#4a4460" style="pointer-events:none">${esc(label || id)}</text>`);
  }
  lines.push(`  </g>`);

  // --- decorations layer: cosmetic-only entries (rooms.json decorative:true) ---
  // Never a room, never has furniture/fixtures. inkscape:label carries the
  // real identity (e.g. "closet:cleaning") — that's what the importer keys
  // off of, not this rect's id, since Illustrator id-mangles duplicates.
  lines.push(`  <g id="decorations" inkscape:label="decorations" inkscape:groupmode="layer">`);
  for (const room of rooms) {
    if (!room.decorative || !room.rect) continue;
    const { id, label, rect } = room;
    const decLabel = id.replace(/-/, ':');
    const attrs = rectAttrs({
      x: rect.x, y: rect.y, w: rect.w, h: rect.h,
      id: `decoration:${id}`,
      extraAttrs: `inkscape:label="${esc(decLabel)}" class="decoration" style="fill:rgba(160,142,122,0.05);stroke:#a08e7a;stroke-width:1;stroke-dasharray:3 3"`,
    });
    lines.push(`    <rect ${attrs} />`);
    lines.push(`    <text x="${num(rect.x + 6)}" y="${num(rect.y + 15)}" font-size="8" font-family="sans-serif" fill="#4a4460" style="pointer-events:none">${esc(label || id)}</text>`);
  }
  lines.push(`  </g>`);

  // --- furniture layer ---
  lines.push(`  <g id="furniture" inkscape:label="furniture" inkscape:groupmode="layer">`);
  for (const room of rooms) {
    if (room.decorative) continue;
    const { id: roomId, rect } = room;
    if (!rect || !Array.isArray(room.furniture)) continue;
    room.furniture.forEach((item, idx) => {
      const absX = rect.x + item.x;
      const absY = rect.y + item.y;
      const rotDeg = parseRotDeg(item.rot);
      const wrap = rotDeg !== null;
      if (wrap) {
        const cx = num(absX + item.w / 2);
        const cy = num(absY + item.h / 2);
        lines.push(`    <g transform="rotate(${num(rotDeg)} ${cx} ${cy})">`);
      }
      // data-rot is stashed on the rect itself (belt-and-suspenders
      // alongside the wrapping g's rotate transform, which is cosmetic-only
      // for our own generated files — see import's handling of transforms)
      lines.push(buildFurnitureRect(roomId, idx, null, item, absX, absY));
      (item.kids || []).forEach((kid, kidIdx) => {
        const kidAbsX = absX + kid.x;
        const kidAbsY = absY + kid.y;
        lines.push(buildFurnitureRect(roomId, idx, kidIdx, kid, kidAbsX, kidAbsY));
      });
      if (wrap) lines.push(`    </g>`);
    });
  }
  lines.push(`  </g>`);

  // --- fixtures layer ---
  // A device with more than one position (rooms.json fixtures[device] is an
  // array) becomes multiple <circle>s: the first plain id, the rest
  // "-2"/"-3"/... suffixed (Illustrator's own dup-id convention), all
  // carrying an inkscape:label "fixture:room:device:<index>" (1-based) so
  // the importer can tell them apart and re-order them regardless of what
  // an editor does to the ids.
  lines.push(`  <g id="fixtures" inkscape:label="fixtures" inkscape:groupmode="layer">`);
  for (const room of rooms) {
    if (room.decorative) continue;
    const { id: roomId, rect } = room;
    if (!rect || !room.fixtures) continue;
    for (const [deviceId, posOrArr] of Object.entries(room.fixtures)) {
      if (!posOrArr) continue;
      const positions = Array.isArray(posOrArr) ? posOrArr : [posOrArr];
      positions.forEach((pos, i) => {
        if (!pos) return;
        const n = i + 1;
        const cx = rect.x + pos.x;
        const cy = rect.y + pos.y;
        const id = n === 1 ? `fixture:${roomId}:${deviceId}` : `fixture:${roomId}:${deviceId}-${n}`;
        const labelAttr = positions.length > 1 ? ` inkscape:label="fixture:${esc(roomId)}:${esc(deviceId)}:${n}"` : '';
        lines.push(`    <circle id="${esc(id)}" cx="${num(cx)}" cy="${num(cy)}" r="5" style="fill:#e0834d;stroke:#7a3f14;stroke-width:1"${labelAttr} />`);
        if (n === 1) {
          lines.push(`    <text x="${num(cx + 8)}" y="${num(cy + 3)}" font-size="8" font-family="sans-serif" fill="#7a3f14" style="pointer-events:none">${esc(deviceId)}</text>`);
        }
      });
    }
  }
  lines.push(`  </g>`);

  // --- fallback: full JSON source, hidden ---
  const jsonBlob = JSON.stringify(rooms);
  lines.push(`  <metadata id="apollo-rooms-source"><![CDATA[${jsonBlob}]]></metadata>`);

  lines.push('</svg>');
  lines.push('');

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, lines.join('\n'), 'utf8');
  const roomCount = rooms.filter((r) => !r.decorative).length;
  const decCount = rooms.filter((r) => r.decorative).length;
  process.stdout.write(`floorplan-export: wrote ${path.relative(ROOT, OUT_FILE)} (${roomCount} rooms, ${decCount} decorations)\n`);
}

main();
