// Apollo v2 dashboard -- best-effort hex/rgb/named-color -> rgba(...) at a
// given alpha, used to tint a device row's fill bar toward its live color
// (color-capable lights only; everything else falls back to amber).

/**
 * @param {string|null|undefined} color - '#rrggbb', '#rgb', or any CSS color
 * @param {number} alpha - 0-1
 * @returns {string|null} an rgba(...)/color-mix(...) string, or null if no color
 */
export function colorToRgba(color, alpha) {
  if (!color) return null;
  if (color[0] === '#') {
    let hex = color.slice(1);
    if (hex.length === 3) {
      hex = hex.split('').map((c) => c + c).join('');
    }
    const num = parseInt(hex, 16);
    if (Number.isNaN(num)) return null;
    const r = (num >> 16) & 255;
    const g = (num >> 8) & 255;
    const b = num & 255;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  // Named colors / rgb()/hsl() strings: color-mix keeps this a one-liner
  // without shipping a full CSS color parser for an edge case.
  return `color-mix(in srgb, ${color} ${Math.round(alpha * 100)}%, transparent)`;
}
