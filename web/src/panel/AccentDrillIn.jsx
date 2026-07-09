// Apollo v2 dashboard -- Accent drill-in: the honest, scenes-first view behind
// the AccentRow preset pills.
//
// DMX model (from the Apollo-Dmx-Bridge repo): there are two physical
// fixtures, `adj` and `spot`. Executing a preset on a fixture REPLACES that
// fixture's state -- hardware only ever holds one preset per fixture at a
// time, so each fixture's presets are single-select (radio), not independent
// toggles. Scenes set one preset per fixture across both fixtures at once and
// are the coordinated, most-used looks, so they're shown first.
//
// DMX publishes no live state back to Apollo (see optimistic.js's
// NEVER_CONFIRMS_TYPES), so every on/off shown here -- including the
// radio-sibling-off inferred below -- is optimistic only, never confirmed.

import { store, commands } from '../state/index.js';
import { DrillInShell, SegmentedGroup } from './DrillInShell.jsx';

const FONT = "'Outfit', system-ui, sans-serif";

// Display order within each fixture (config's dmxFixture entries carry a
// `fixture: 'adj'|'spot'` field -- that's the authoritative grouping; these
// arrays are just for stable ordering, and an id absent from config simply
// drops out via the `.filter(Boolean)` below).
const ADJ_ORDER = ['ceiling', 'webcam-back'];
const SPOT_ORDER = ['deer', 'end-table', 'coffee-table', 'mirrorball-subtle'];
const SCENE_IDS = ['wolf', 'mirrorball', 'dmxManual'];

/** Entries for one fixture, in the fixed display order above (any entry not
 * in `order` -- e.g. a preset added to config later -- is appended at the
 * end rather than dropped). */
function entriesForFixture(accentEntries, fixture, order) {
  const inFixture = accentEntries.filter((entry) => entry.fixture === fixture);
  const byId = new Map(inFixture.map((entry) => [entry.id, entry]));
  const ordered = order.map((id) => byId.get(id)).filter(Boolean);
  const rest = inFixture.filter((entry) => !order.includes(entry.id));
  return [...ordered, ...rest];
}

/**
 * Select one preset within a fixture: fires the real command for the tapped
 * preset (if it wasn't already on), then optimistically clears the on-state
 * of every other preset in the SAME fixture. The DMX bridge already makes
 * this exclusive in hardware -- we don't send an "off" for the siblings
 * (there's no such command, and no need for one), we just correct the local
 * optimistic view to match what the hardware will actually do, since nothing
 * ever comes back over MQTT to reconcile it for us.
 * @param {object} entry - the preset entry being selected
 * @param {Array<object>} siblings - all presets in the same fixture
 */
function selectPreset(entry, siblings) {
  if (!commands.deviceView(entry).on) {
    commands.toggle(entry);
  }
  for (const sibling of siblings) {
    if (sibling.id === entry.id) continue;
    if (commands.deviceView(sibling).on) {
      store.updateDevice(sibling.stateTopic, (e) => ({
        ...e,
        live: { ...e.live, power: 'OFF' },
      }));
    }
  }
}

/**
 * Builds a radio-style item list for one fixture's presets plus a synthetic
 * "Off" item that turns off whichever preset is currently active. Rendered
 * through SegmentedGroup, whose "on" highlight then reads as the radio
 * selection since at most one item in the list is ever on.
 * @param {Array<object>} presetEntries - this fixture's dmxFixture entries
 */
function toFixtureItems(presetEntries) {
  if (!presetEntries.length) return [];
  const items = presetEntries.map((entry) => ({
    id: entry.id,
    title: entry.title || entry.id,
    on: commands.deviceView(entry).on,
    onToggle: () => selectPreset(entry, presetEntries),
  }));
  const anyOn = items.some((item) => item.on);
  items.push({
    id: 'off',
    title: 'Off',
    on: !anyOn,
    onToggle: () => {
      presetEntries.forEach((entry) => {
        if (commands.deviceView(entry).on) commands.toggle(entry);
      });
    },
  });
  return items;
}

/**
 * @param {object} props
 * @param {Array<object>} props.accentEntries - the room's dmxFixture entries
 *   (from RoomPanel, already filtered to this room)
 * @param {() => void} props.onBack
 */
function AccentDrillIn({ accentEntries, onBack }) {
  const adjItems = toFixtureItems(entriesForFixture(accentEntries, 'adj', ADJ_ORDER));
  const spotItems = toFixtureItems(entriesForFixture(accentEntries, 'spot', SPOT_ORDER));

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
    <DrillInShell title="Accent · DMX" onBack={onBack}>
      <SegmentedGroup label="Scenes" items={sceneItems} />
      <SegmentedGroup label="Adj fixture" items={adjItems} />
      <SegmentedGroup label="Spot fixture" items={spotItems} />
      <div
        style={{
          fontFamily: FONT,
          fontWeight: 300,
          fontSize: 11,
          lineHeight: 1.5,
          color: 'var(--text-tertiary, rgba(234, 229, 239, 0.32))',
        }}
      >
        DMX publishes no live state back to Apollo -- on/off shown here
        (including which preset is "active" per fixture) is best-effort and
        optimistic only, not a confirmed reading.
      </div>
    </DrillInShell>
  );
}

export default AccentDrillIn;
