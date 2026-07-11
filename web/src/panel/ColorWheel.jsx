// Apollo v2 dashboard -- touch-friendly HSV hue/saturation picker, rendered
// by DeviceRow's color drill-in alongside ColorSwatches. Brightness/value is
// locked at 1 here; the dim slider elsewhere in the panel owns brightness.
//
// Angle/saturation mapping: hue is the angle clockwise from 12 o'clock (a
// point straight up is red/h=0, straight right is h=90, ...), matching the
// `conic-gradient(red, yellow, lime, cyan, blue, magenta, red)` painted on
// the disc. Saturation is distance from center over radius, clamped to
// [0,1] -- a drag that leaves the disc still resolves to a real color at
// full saturation rather than being ignored.
//
// Preview/commit contract (mirrors useDragGesture's release policy, but
// simpler since there's no tap/dead-zone case for a 2D picker): onPreview
// fires on pointerdown and then at most once per animation frame while
// dragging, so the caller can update a local swatch without spamming
// commands. onCommit fires exactly once, on pointerup *or* pointercancel --
// a cancelled gesture still commits the last tracked position rather than
// silently dropping the drag.

import { useCallback, useRef, useState } from 'preact/hooks';
import { hexToHsv, hsvToHex } from './colorWheelMath.js';

const THUMB_SIZE = 22;

/**
 * @param {object} props
 * @param {string|null} props.color - current '#rrggbb' (thumb position; may be null)
 * @param {(hex: string) => void} props.onPreview - fired during drag (rAF-throttled)
 * @param {(hex: string) => void} props.onCommit - fired once on release
 * @param {number} [props.size] - wheel diameter in px, default 190
 */
function ColorWheel({ color, onPreview, onCommit, size = 190 }) {
  const wheelRef = useRef(null);
  const dragRef = useRef(null);
  const [dragHsv, setDragHsv] = useState(null);

  const hsFromEvent = useCallback((event) => {
    const wheel = wheelRef.current;
    if (!wheel) return null;
    const rect = wheel.getBoundingClientRect();
    const radius = rect.width / 2;
    const dx = event.clientX - (rect.left + radius);
    const dy = event.clientY - (rect.top + radius);
    let angle = (Math.atan2(dx, -dy) * 180) / Math.PI;
    if (angle < 0) angle += 360;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const s = radius > 0 ? Math.min(1, dist / radius) : 0;
    return { h: angle, s };
  }, []);

  const onPointerDown = useCallback((event) => {
    if (event.currentTarget.setPointerCapture) {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    const hs = hsFromEvent(event);
    if (!hs) return;
    dragRef.current = { rafId: null, pending: hs };
    setDragHsv(hs);
    onPreview(hsvToHex(hs.h, hs.s, 1));
  }, [hsFromEvent, onPreview]);

  const onPointerMove = useCallback((event) => {
    const drag = dragRef.current;
    if (!drag) return;
    const hs = hsFromEvent(event);
    if (!hs) return;
    drag.pending = hs;
    if (drag.rafId == null) {
      drag.rafId = requestAnimationFrame(() => {
        drag.rafId = null;
        const pending = drag.pending;
        setDragHsv(pending);
        onPreview(hsvToHex(pending.h, pending.s, 1));
      });
    }
  }, [hsFromEvent, onPreview]);

  const endDrag = useCallback((event) => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    if (drag.rafId != null) {
      cancelAnimationFrame(drag.rafId);
      drag.rafId = null;
    }
    if (event.currentTarget.releasePointerCapture) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    // pointerup gets a fresh read when possible; pointercancel's position
    // can be unreliable, so it falls back to the last tracked drag value --
    // either way the commit still fires, never silently dropped.
    const hs = (event.type === 'pointerup' && hsFromEvent(event)) || drag.pending;
    setDragHsv(null);
    onCommit(hsvToHex(hs.h, hs.s, 1));
  }, [hsFromEvent, onCommit]);

  const staticHsv = !dragHsv && color ? hexToHsv(color) : null;
  const hsv = dragHsv || staticHsv;
  const thumbHex = dragHsv ? hsvToHex(dragHsv.h, dragHsv.s, 1) : color;

  let thumbLeft = 0;
  let thumbTop = 0;
  if (hsv) {
    const radius = size / 2;
    const hRad = (hsv.h * Math.PI) / 180;
    const dist = hsv.s * radius;
    thumbLeft = radius + Math.sin(hRad) * dist - THUMB_SIZE / 2;
    thumbTop = radius - Math.cos(hRad) * dist - THUMB_SIZE / 2;
  }

  return (
    <div style={{ display: 'flex', justifyContent: 'center' }}>
      <div
        ref={wheelRef}
        aria-label="Color wheel"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        style={{
          position: 'relative',
          width: size,
          height: size,
          borderRadius: '50%',
          border: '1px solid rgba(20, 17, 26, 0.35)',
          background:
            'radial-gradient(circle closest-side, #fff, rgba(255,255,255,0)), ' +
            'conic-gradient(red, yellow, lime, cyan, blue, magenta, red)',
          touchAction: 'none',
          cursor: 'pointer',
        }}
      >
        {hsv && (
          <div
            style={{
              position: 'absolute',
              left: thumbLeft,
              top: thumbTop,
              width: THUMB_SIZE,
              height: THUMB_SIZE,
              borderRadius: '50%',
              background: thumbHex,
              border: '2px solid #eae5ef',
              boxShadow: '0 1px 4px rgba(0, 0, 0, 0.4)',
              pointerEvents: 'none',
            }}
          />
        )}
      </div>
    </div>
  );
}

export default ColorWheel;
