// Apollo v2 dashboard -- Accent drill-in (increment 3): the honest,
// two-fixture-group view behind the AccentRow preset pills. The pills only
// surface 3 of the 6 DMX fixtures plus none of the 3 DMX scenes; this drill-in
// exposes all of it via the shared DrillInShell/SegmentedGroup chrome.

import { store, commands } from '../state/index.js';
import { DrillInShell, SegmentedGroup } from './DrillInShell.jsx';

const FONT = "'Outfit', system-ui, sans-serif";

const ADJ_IDS = ['ceiling', 'webcam-back'];
const SPOT_IDS = ['deer', 'end-table', 'coffee-table', 'mirrorball-subtle'];
const SCENE_IDS = ['wolf', 'mirrorball', 'dmxManual'];

function byId(entries) {
  const map = new Map();
  for (const entry of entries) map.set(entry.id, entry);
  return map;
}

function toSegmentItems(entriesById, ids) {
  return ids
    .map((id) => entriesById.get(id))
    .filter(Boolean)
    .map((entry) => ({
      id: entry.id,
      title: entry.title || entry.id,
      on: commands.deviceView(entry).on,
      onToggle: () => commands.toggle(entry),
    }));
}

/**
 * @param {object} props
 * @param {Array<object>} props.accentEntries - the room's dmxFixture entries
 *   (from RoomPanel, already filtered to this room)
 * @param {() => void} props.onBack
 */
function AccentDrillIn({ accentEntries, onBack }) {
  const fixturesById = byId(accentEntries);
  const adjItems = toSegmentItems(fixturesById, ADJ_IDS);
  const spotItems = toSegmentItems(fixturesById, SPOT_IDS);

  const scenes = store.scenes.value;
  const sceneItems = SCENE_IDS
    .map((id) => scenes.get(id))
    .filter(Boolean)
    .map((entry) => ({
      id: entry.id,
      title: entry.title || entry.id,
      on: Boolean(entry.active),
      onToggle: () => commands.toggleScene(entry),
    }));

  return (
    <DrillInShell title="Accent controls" onBack={onBack}>
      <SegmentedGroup label="ADJ fixture" items={adjItems} />
      <SegmentedGroup label="Spot fixture" items={spotItems} />
      <SegmentedGroup label="DMX scenes" items={sceneItems} />
      <div
        style={{
          fontFamily: FONT,
          fontWeight: 300,
          fontSize: 11,
          lineHeight: 1.5,
          color: 'var(--text-tertiary, rgba(234, 229, 239, 0.32))',
        }}
      >
        DMX publishes no live state back to Apollo -- on/off shown here is
        best-effort and optimistic only, not a confirmed reading.
      </div>
    </DrillInShell>
  );
}

export default AccentDrillIn;
