// Apollo v2 dashboard -- pure hex<->HSV conversion helpers backing
// ColorWheel's disc geometry. No imports, no Preact -- easy to unit-test in
// isolation and reused for both the thumb-position math (hex -> h/s) and the
// drag-preview math (h/s -> hex).

const HEX3_RE = /^[0-9a-f]{3}$/i;
const HEX6_RE = /^[0-9a-f]{6}$/i;

/**
 * @param {string|null|undefined} hex - '#rrggbb', 'rrggbb', or '#rgb'
 * @returns {{h: number, s: number, v: number}|null} h in [0,360), s/v in
 *   [0,1], or null if hex is missing/unparseable
 */
export function hexToHsv(hex) {
  if (!hex) return null;
  let stripped = hex[0] === '#' ? hex.slice(1) : hex;
  if (HEX3_RE.test(stripped)) {
    stripped = stripped.split('').map((c) => c + c).join('');
  } else if (!HEX6_RE.test(stripped)) {
    return null;
  }

  const r = parseInt(stripped.slice(0, 2), 16) / 255;
  const g = parseInt(stripped.slice(2, 4), 16) / 255;
  const b = parseInt(stripped.slice(4, 6), 16) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;

  const v = max;
  const s = max === 0 ? 0 : delta / max;

  let h = 0;
  if (delta !== 0) {
    if (max === r) {
      h = 60 * (((g - b) / delta) % 6);
    } else if (max === g) {
      h = 60 * ((b - r) / delta + 2);
    } else {
      h = 60 * ((r - g) / delta + 4);
    }
    if (h < 0) h += 360;
  }

  return { h, s, v };
}

/**
 * @param {number} h - hue in [0,360)
 * @param {number} s - saturation in [0,1]
 * @param {number} v - value/brightness in [0,1]
 * @returns {string} '#rrggbb', lowercase
 */
export function hsvToHex(h, s, v) {
  const hue = ((h % 360) + 360) % 360;
  const sat = Math.max(0, Math.min(1, s));
  const val = Math.max(0, Math.min(1, v));

  const c = val * sat;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = val - c;

  let r1 = 0;
  let g1 = 0;
  let b1 = 0;
  if (hue < 60) {
    r1 = c; g1 = x; b1 = 0;
  } else if (hue < 120) {
    r1 = x; g1 = c; b1 = 0;
  } else if (hue < 180) {
    r1 = 0; g1 = c; b1 = x;
  } else if (hue < 240) {
    r1 = 0; g1 = x; b1 = c;
  } else if (hue < 300) {
    r1 = x; g1 = 0; b1 = c;
  } else {
    r1 = c; g1 = 0; b1 = x;
  }

  const toByte = (channel) => {
    const n = Math.round((channel + m) * 255);
    return Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0');
  };

  return `#${toByte(r1)}${toByte(g1)}${toByte(b1)}`;
}
