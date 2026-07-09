// Apollo v2 dashboard -- consolidated "..." overflow for the scene/macro bar.
//
// Per the tiered model (dashboard-redesign-plan.md §4.2) this is ONE menu for
// both scenes and macros -- not a separate menu per class -- listing whatever
// is left over after the default bar, the room-scoped scene bar, and the
// Accent drill-in have claimed their entries. Data-driven off
// registry.MORE_ENTRIES so adding a future overflow item is a one-line change
// there, not a JSX edit here.

import { useEffect, useRef, useState } from 'preact/hooks';
import { store } from '../state/index.js';
import { MORE_ENTRIES, resolveEntry } from './registry.js';
import { SceneMacroButton } from './Button.jsx';
import './scenes.css';

export default function MoreMenu() {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  // Outside-click / Escape dismissal. Capture-phase pointerdown so this fires
  // before any click handler on whatever was clicked; a click ON the trigger
  // itself is inside wrapRef, so it's left alone here and handled by the
  // trigger's own onClick toggle below.
  useEffect(() => {
    if (!open) return undefined;

    function onPointerDown(event) {
      if (wrapRef.current && !wrapRef.current.contains(event.target)) {
        setOpen(false);
      }
    }
    function onKeyDown(event) {
      if (event.key === 'Escape') setOpen(false);
    }

    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const scenesMap = store.scenes.value;
  const macrosMap = store.macros.value;

  return (
    <div class="more-menu-wrap" ref={wrapRef}>
      <button
        type="button"
        class={`more-trigger${open ? ' is-open' : ''}`}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label="More scenes and macros"
        onClick={() => setOpen((v) => !v)}
      >
        ···
      </button>
      {open && (
        <div class="more-menu" role="menu">
          {MORE_ENTRIES.map(({ kind, id }) => {
            const entry = resolveEntry(kind, id, scenesMap, macrosMap);
            if (!entry) return null;
            return (
              <SceneMacroButton
                key={`${kind}:${id}`}
                kind={kind}
                entry={entry}
                extraClass="more-menu-item"
                onAfterClick={() => setOpen(false)}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

export { MoreMenu };
