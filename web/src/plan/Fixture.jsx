// Apollo v2 dashboard -- isometric plane fixture dot.
//
// A fixture entry in room.fixtures is keyed by a deviceId (e.g. "kitchen",
// "livingRoomCouch") and gives its {x,y} position relative to the room's
// rect. We look up the matching device entry via store.devicesInRoom(room.id)
// (matching entry.id === deviceId) and render its on/off/color state via
// commands.deviceView(entry). Some fixture keys are virtual and have no
// backing device entry at all -- e.g. the living room's "accent" dot, which
// represents a DMX preset picker (Ceiling/Deer/Mirror Ball/etc are presets on
// one physical fixture, not separate addressable devices) -- those render as
// a dim neutral dot with no halo, same as an off device.

import { store, commands } from '../state/index.js';

const DEFAULT_GLOW = '#ffb267';
const OFF_BG = 'rgba(234,229,239,.15)';

/**
 * @param {{ deviceId: string, pos: {x:number,y:number}, room: object }} props
 */
export default function Fixture({ deviceId, pos, room }) {
  const entries = store.devicesInRoom(room.id);
  const entry = entries.find((e) => e.id === deviceId) || null;

  let background = OFF_BG;
  let boxShadow = 'none';

  if (entry) {
    const view = commands.deviceView(entry);
    if (view.on) {
      const color = view.color || DEFAULT_GLOW;
      background = color;
      boxShadow = `0 0 16px 5px ${withAlpha(color, 0.45)}`;
    }
  }

  const style = {
    position: 'absolute',
    left: `${pos.x - 5}px`,
    top: `${pos.y - 5}px`,
    width: '10px',
    height: '10px',
    borderRadius: '50%',
    background,
    boxShadow,
    transition: 'background .3s, box-shadow .3s',
    pointerEvents: 'none',
  };

  return <div class="plan-fixture" style={style} />;
}

/**
 * Best-effort rgba() rebuild of a color string at a given alpha, for the
 * fixture halo (also used by GlowLayer's gradients). Handles #rgb/#rrggbb and
 * rgb()/rgba() inputs (the two shapes deviceView colors realistically come in
 * as); anything else (named colors, hsl()) is passed through unchanged -- the
 * halo still renders, just without the reduced alpha.
 * @param {string} color
 * @param {number} alpha
 * @returns {string}
 */
export function withAlpha(color, alpha) {
  if (typeof color !== 'string') return `rgba(255,178,102,${alpha})`;

  if (color[0] === '#') {
    const hex = color.slice(1);
    const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex.padEnd(6, '0').slice(0, 6);
    const r = parseInt(full.slice(0, 2), 16);
    const g = parseInt(full.slice(2, 4), 16);
    const b = parseInt(full.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }

  if (color.startsWith('rgb')) {
    const nums = color.match(/[\d.]+/g) || [];
    const [r, g, b] = nums;
    if (r !== undefined && g !== undefined && b !== undefined) {
      return `rgba(${r},${g},${b},${alpha})`;
    }
  }

  return color;
}
