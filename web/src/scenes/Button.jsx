// Apollo v2 dashboard -- shared scene-pill / macro-button control.
//
// SceneBar, MoreMenu, and RoomSceneBar all render the same two visuals for a
// tier entry (a pill for a lightingScene, a dashed amber button for a macro);
// this is the one place that knows the label/class/dispatch rules so the
// three surfaces can't drift from each other.

import { commands } from '../state/index.js';

/**
 * @param {object} props
 * @param {'scene'|'macro'} props.kind
 * @param {object} props.entry - a store.scenes/store.macros record ({id, title, active, ...})
 * @param {string} [props.extraClass] - additional class, e.g. MoreMenu's row treatment
 * @param {() => void} [props.onAfterClick] - e.g. MoreMenu closing itself post-dispatch
 */
export function SceneMacroButton({ kind, entry, extraClass = '', onAfterClick }) {
  const isMacro = kind === 'macro';
  // Macro labels are prefixed "▸ " per the design -- the visual cue that this
  // is a multi-step macro, not a single lightingScene activation.
  const label = isMacro ? `▸ ${entry.title}` : entry.title;
  const baseClass = isMacro ? 'macro-btn' : 'scene-pill';
  const activeClass = entry.active ? ' is-active' : '';

  return (
    <button
      type="button"
      class={`${baseClass}${activeClass}${extraClass ? ` ${extraClass}` : ''}`}
      aria-pressed={Boolean(entry.active)}
      onClick={() => {
        if (isMacro) commands.toggleMacro(entry);
        else commands.toggleScene(entry);
        if (onAfterClick) onAfterClick();
      }}
    >
      {label}
    </button>
  );
}

export default SceneMacroButton;
