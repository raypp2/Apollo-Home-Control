// Apollo v2 dashboard -- mobile "next" layout: shared drag-to-set volume bar
// used by both Dock.jsx (compact, source label overlaid) and MediaTab.jsx
// (full-width fine control). Mirrors av/VolumeBar.jsx's dB math and
// position-based drag/tap semantics exactly (see pctToDb/dbToPct there) --
// kept as its own small component rather than reusing VolumeBar directly
// because the dock needs a source label overlaid inside the bar, which
// VolumeBar's API has no slot for.

import { useRef, useState } from 'preact/hooks';
import { pctToDb, dbToPct } from '../av/index.js';
import './dock.css';

/** Minimum ms between onChange calls while dragging (network sends are real
 * /api commands -- throttle like VolumeBar does). */
const DRAG_THROTTLE_MS = 100;

/**
 * @param {object} props
 * @param {number} props.db - current volume in dB (negative)
 * @param {boolean} [props.muted]
 * @param {string} [props.sourceLabel] - left-aligned label inside the bar
 *   (e.g. "Spotify"); omitted entirely when not given.
 * @param {number} [props.height] - bar height in px (default 44, per Dock spec)
 * @param {(db:number)=>void} props.onChange - fires on tap and on every drag
 *   move (position-based, so there's no separate preview/commit split); the
 *   final position on release always fires once more so a throttled-out
 *   value still reaches the receiver.
 */
function VolumeControl({ db, muted = false, sourceLabel, height = 44, onChange }) {
  const trackRef = useRef(null);
  const dragRef = useRef(null);
  const [dragDb, setDragDb] = useState(null);

  function valueFromEvent(event) {
    const rect = trackRef.current.getBoundingClientRect();
    const pct = rect.width > 0 ? ((event.clientX - rect.left) / rect.width) * 100 : 0;
    return pctToDb(Math.max(0, Math.min(100, pct)));
  }

  function onPointerDown(event) {
    if (event.currentTarget.setPointerCapture) {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    const val = valueFromEvent(event);
    dragRef.current = { lastSend: Date.now() };
    setDragDb(val);
    onChange(val);
  }

  function onPointerMove(event) {
    if (!dragRef.current || event.buttons === 0) return;
    const val = valueFromEvent(event);
    setDragDb(val);
    const now = Date.now();
    if (now - dragRef.current.lastSend >= DRAG_THROTTLE_MS) {
      dragRef.current.lastSend = now;
      onChange(val);
    }
  }

  function endDrag(event) {
    if (!dragRef.current) return;
    dragRef.current = null;
    onChange(valueFromEvent(event));
    setDragDb(null);
  }

  const displayDb = dragDb !== null ? dragDb : db;
  const pct = dbToPct(displayDb);

  return (
    <div
      ref={trackRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      className="next-volume-track"
      style={{ height }}
      role="slider"
      aria-label="Volume"
      aria-valuemin={-80}
      aria-valuemax={0}
      aria-valuenow={Math.round(displayDb)}
    >
      <div className="next-volume-fill" style={{ width: `${pct}%` }} aria-hidden="true" />
      <div className="next-volume-labels" aria-hidden="true">
        <span className="next-volume-source">{sourceLabel || ''}</span>
        <span className="next-volume-db">
          {muted ? 'Muted' : `${Math.round(displayDb)} dB`}
        </span>
      </div>
    </div>
  );
}

export default VolumeControl;
