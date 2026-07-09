// Apollo v2 dashboard -- increment 3 scene/macro bar (top-bar-right cluster).
//
// Tiered scene model (documentation/dashboard-redesign-plan.md §4.2): the five
// default-visible entries -- two lightingScenes rendered as pills, three
// macros rendered as dashed-amber buttons -- plus the consolidated "..."
// overflow (MoreMenu). See registry.js for the full tiering and the collision
// rule (macro wins when a scene shares its title).
//
// Increment 6: the "allLights" slot no longer renders as a single toggle
// pill -- On and Off are the two things actually reached for, so it renders
// as a SplitChip (one chip, two explicit buttons) instead of guessing intent
// from the ambient `active` flag.

import { store, commands } from '../state/index.js';
import { DEFAULT_ENTRIES, resolveEntry } from './registry.js';
import { SceneMacroButton } from './Button.jsx';
import { SplitChip } from './SplitChip.jsx';
import MoreMenu from './MoreMenu.jsx';
import './scenes.css';

export default function SceneBar() {
  // Reading .value here is what subscribes this component to scene/macro
  // updates (both the initial /list/* hydration and later MQTT-driven active
  // flips); resolveEntry() itself is a plain, non-reactive Map read.
  const scenesMap = store.scenes.value;
  const macrosMap = store.macros.value;

  return (
    <div class="scene-bar">
      <div class="scene-bar-scroll">
        {DEFAULT_ENTRIES.map(({ kind, id }) => {
          const entry = resolveEntry(kind, id, scenesMap, macrosMap);
          // Config entry not present in this deployment's scenes/macros
          // config -- skip gracefully rather than rendering a broken button.
          if (!entry) return null;
          if (kind === 'scene' && id === 'allLights') {
            return (
              <SplitChip
                key="allLights"
                label={entry.title}
                entry={entry}
                onOn={() => commands.setScene(entry, true)}
                onOff={() => commands.setScene(entry, false)}
              />
            );
          }
          return <SceneMacroButton key={`${kind}:${id}`} kind={kind} entry={entry} />;
        })}
      </div>
      <MoreMenu />
    </div>
  );
}

export { SceneBar };
