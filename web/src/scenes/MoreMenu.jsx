// Apollo v2 dashboard -- consolidated "..." overflow for the scene/macro bar.
//
// Per the tiered model (dashboard-redesign-plan.md §4.2) this is ONE menu for
// both scenes and macros -- not a separate menu per class -- listing whatever
// is left over after the default bar, the room-scoped scene bar, and the
// Accent drill-in have claimed their entries. Data-driven off
// registry.MORE_ENTRIES so adding a future overflow item is a one-line change
// there, not a JSX edit here. Below the scene/macro list it also carries the
// whole-home UTILITY section (door buzzer, Find My iPhone) -- see increment
// 6, moved off the top-bar utility rail to make room there.
//
// Popover positioning: `.topbar-scenes` (the scene bar's ancestor) is
// `overflow: hidden` so it can own its own horizontal scroll region without
// growing the top bar. A plain `position: absolute` popover anchored inside
// that ancestor gets clipped by it. Fix: render `.more-menu` as
// `position: fixed`, anchored off the trigger button's own
// getBoundingClientRect() at open time -- a fixed-position box is laid out
// against the viewport, not any ancestor's box, so it escapes clipping from
// any ancestor that isn't itself a containing block for fixed descendants
// (i.e. one with a transform/filter/perspective/will-change), none of which
// sit between here and the viewport.

import { useEffect, useRef, useState } from 'preact/hooks';
import { store, commands } from '../state/index.js';
import { MORE_ENTRIES, resolveEntry } from './registry.js';
import { SceneMacroButton } from './Button.jsx';
import './scenes.css';

/** Finds the whole-home door (iTach contact-closure) and Find My iPhone entries. */
function useUtilityDevices() {
  const deviceMap = store.devices.value;
  let door = null;
  let phone = null;
  for (const entry of deviceMap.values()) {
    if (!door && (entry.id === 'door' || entry.type === 'iTach_CC')) door = entry;
    if (!phone && entry.type === 'findMyIphone') phone = entry;
    if (door && phone) break;
  }
  return { door, phone };
}

export default function MoreMenu() {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const wrapRef = useRef(null);
  const triggerRef = useRef(null);

  // Outside-click / Escape dismissal. Capture-phase pointerdown so this fires
  // before any click handler on whatever was clicked; a click ON the trigger
  // itself is inside wrapRef, so it's left alone here and handled by the
  // trigger's own onClick toggle below. The popover itself is a DOM child of
  // wrapRef (fixed positioning only changes where it's painted, not where
  // it lives in the tree), so `wrapRef.current.contains(...)` still covers
  // clicks inside the open menu.
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

  function toggleOpen() {
    setOpen((wasOpen) => {
      const willOpen = !wasOpen;
      if (willOpen && triggerRef.current) {
        const rect = triggerRef.current.getBoundingClientRect();
        setPos({ top: rect.bottom + 6, right: window.innerWidth - rect.right });
      }
      return willOpen;
    });
  }

  const scenesMap = store.scenes.value;
  const macrosMap = store.macros.value;
  const { door, phone } = useUtilityDevices();
  const hasUtility = Boolean(door || phone);

  return (
    <div class="more-menu-wrap" ref={wrapRef}>
      <button
        type="button"
        ref={triggerRef}
        class={`more-trigger${open ? ' is-open' : ''}`}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label="More scenes and macros"
        onClick={toggleOpen}
      >
        ···
      </button>
      {open && pos && (
        <div
          class="more-menu"
          role="menu"
          style={{ top: `${pos.top}px`, right: `${pos.right}px` }}
        >
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

          {hasUtility && (
            <>
              <div class="more-menu-divider" role="separator" />
              <div class="more-menu-heading">Utility</div>
              {door && (
                <button
                  type="button"
                  class="more-menu-item more-menu-util-btn"
                  role="menuitem"
                  onClick={() => {
                    commands.buzzDoor(door, 'front');
                    setOpen(false);
                  }}
                >
                  🔓 Door — Front
                </button>
              )}
              {door && (
                <button
                  type="button"
                  class="more-menu-item more-menu-util-btn"
                  role="menuitem"
                  onClick={() => {
                    commands.buzzDoor(door, 'apartment');
                    setOpen(false);
                  }}
                >
                  🔓 Door — Apartment
                </button>
              )}
              {phone && (
                <button
                  type="button"
                  class="more-menu-item more-menu-util-btn"
                  role="menuitem"
                  onClick={() => {
                    commands.pingPhone(phone);
                    setOpen(false);
                  }}
                >
                  📱 Find My iPhone
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

export { MoreMenu };
