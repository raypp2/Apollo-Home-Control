// Apollo v2 dashboard -- Room Command Panel.
//
// Right column: a room on/off+dim toggle and the room's device rows in a
// scrollable area, with the AV/climate/now-playing cluster PINNED to the
// bottom so it stays visible while the device list scrolls above it. The 6 DMX
// fixture lights are consolidated into a single AccentRow + drill-in.
//
// The AV zone (living + kitchen + office) is one open-plan space with no walls,
// so the shared AC/Anthem/Spotify/projector controls appear for all three.
//
// Zone panels: rooms.json's `zone` field (e.g. "common" -- kitchen/dining/
// living/office, one continuous space with no interior walls) makes
// ui.selectedRoom hold the ZONE id whenever any member room is tapped (see
// ui.selectRoom). This panel detects that via store.zoneMembers and renders
// ONE shared panel for the whole space: a "Common" title, a master light row
// (RoomToggle) that controls every zone light via commands.roomLights/
// roomToggle/roomDim resolving through store.devicesInZoneOrRoom, the union
// of every member room's device rows (member order preserved), and both
// member rooms' scene-pill presets (registry.roomScenesForZone) since a
// zone has no single scene of its own.

import { useEffect, useState } from 'preact/hooks';
import { store, ui, commands } from '../state/index.js';
import DeviceRow from './DeviceRow.jsx';
import ShadeRow from './ShadeRow.jsx';
import AccentRow from './AccentRow.jsx';
import AccentDrillIn from './AccentDrillIn.jsx';
import ClimateCluster from '../climate/index.js';
import { AvCluster, NowPlaying } from '../av/index.js';
import { RoomToggle } from '../scenes/index.js';
import { roomScenesForZone, resolveEntry } from '../scenes/registry.js';
import { SceneMacroButton } from '../scenes/Button.jsx';

const PANEL_KINDS = new Set(['dim', 'switch', 'color', 'shade']);
const FONT = "'Outfit', system-ui, sans-serif";
// Open-plan zone that shares the living room's AV + climate hardware. Every
// member of the "common" zone (kitchen/dining/living/office) now resolves to
// the "common" zone id before it ever reaches this component (see
// ui.selectRoom), so "common" is what actually needs to match here; the
// individual member ids are kept for defensiveness only.
const AV_ZONE = new Set(['living', 'kitchen', 'office', 'common']);

const PANEL_STYLE = {
  position: 'relative',
  width: '100%',
  height: '100%',
  boxSizing: 'border-box',
  background: 'var(--bg-panel, rgba(20, 17, 26, 0.7))',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
};

const SCROLL_STYLE = {
  flex: 1,
  minHeight: 0,
  overflowY: 'auto',
  padding: '24px 26px',
};

const FOOTER_STYLE = {
  flexShrink: 0,
  borderTop: '1px solid var(--hairline, rgba(234, 229, 239, 0.1))',
  padding: '12px 26px 14px',
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  background: 'var(--bg-panel, rgba(20, 17, 26, 0.7))',
  boxShadow: '0 -8px 20px rgba(0, 0, 0, 0.25)',
};

/** "KITCHEN" -> "Kitchen"; used only for display, ids stay as-is. */
function titleCase(label) {
  if (!label) return '';
  return label
    .toLowerCase()
    .split(' ')
    .map((word) => (word ? word[0].toUpperCase() + word.slice(1) : word))
    .join(' ');
}

function RoomPanel() {
  const selectedRoom = ui.selectedRoom.value;
  const [accentDrillInOpen, setAccentDrillInOpen] = useState(false);

  // Close the drill-in on room change so switching rooms never leaves a
  // stale overlay open over a different room's controls.
  useEffect(() => {
    setAccentDrillInOpen(false);
  }, [selectedRoom]);

  if (!selectedRoom) {
    return (
      <div style={PANEL_STYLE}>
        <div
          style={{
            margin: 'auto',
            textAlign: 'center',
            fontFamily: FONT,
            fontWeight: 400,
            fontSize: 15,
            color: 'rgba(234, 229, 239, 0.4)',
          }}
        >
          Tap a room to control it
        </div>
      </div>
    );
  }

  const zoneMembers = store.zoneMembers(selectedRoom);
  const isZone = zoneMembers.length > 0;
  const room = isZone ? null : store.rooms.value.find((r) => r.id === selectedRoom);
  // titleCase("common") -> "Common"; plain rooms keep their existing label.
  const label = isZone ? titleCase(selectedRoom) : titleCase(room ? room.label : selectedRoom);

  const roomDevices = store.devicesInZoneOrRoom(selectedRoom);
  const accentEntries = roomDevices.filter((entry) => entry.type === 'dmxFixture');
  const entries = roomDevices
    .filter((entry) => entry.type !== 'dmxFixture')
    .filter((entry) => PANEL_KINDS.has(commands.kindOf(entry)));

  // AV/climate cluster: shared across the open-plan "common" zone (kitchen/
  // dining/living/office). The AC/Anthem/Spotify/projector are all configured
  // under the living room, so we find them across every device, not just
  // this room's -- that's already zone-agnostic since it searches every
  // device regardless of which room/zone is selected.
  const inAvZone = AV_ZONE.has(selectedRoom);
  const allDevices = inAvZone ? [...store.devices.value.values()] : [];
  const acEntry = allDevices.find((e) => e.isAC || (e.alexa && e.alexa.isAC)) || null;
  const receiverEntry = allDevices.find((e) => e.speaker) || null; // Anthem has a speaker block
  const projectorEntry = allDevices.find((e) => e.type === 'ip_control' && !e.speaker) || null;
  const spotifyEntry = allDevices.find((e) => e.type === 'spotify') || null;
  const inputScenes = store.deviceScenes.value.map((s) => ({ id: s.id, label: s.title }));
  const hasFooter = acEntry || receiverEntry || spotifyEntry;

  // Zone panel only: a "common" zone has no single scene of its own, so show
  // every member room's scene-pill preset (living, office today) as a
  // shortcut within the shared space, alongside the master light row.
  const zoneScenes = isZone
    ? roomScenesForZone(zoneMembers)
        .map((mapping) => ({
          mapping,
          entry: resolveEntry(mapping.kind, mapping.id, store.scenes.value, store.macros.value),
        }))
        .filter((x) => x.entry)
    : [];

  return (
    <div style={PANEL_STYLE}>
      <div style={SCROLL_STYLE}>
        <div
          style={{
            fontFamily: FONT,
            fontWeight: 600,
            fontSize: 26,
            marginBottom: 14,
            flexShrink: 0,
          }}
        >
          {label}
        </div>

        {commands.roomLights(selectedRoom).length > 1 && (
          <div style={{ marginBottom: 16 }}>
            <RoomToggle roomId={selectedRoom} roomLabel={label} />
          </div>
        )}

        {zoneScenes.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
            {zoneScenes.map(({ mapping, entry }) => (
              <SceneMacroButton key={mapping.id} kind={mapping.kind} entry={entry} />
            ))}
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
          {entries.map((entry) => {
            const kind = commands.kindOf(entry);
            const key = entry.stateTopic || entry.id;
            return kind === 'shade'
              ? <ShadeRow key={key} entry={entry} />
              : <DeviceRow key={key} entry={entry} />;
          })}
          {accentEntries.length > 0 && (
            <AccentRow
              entries={accentEntries}
              onShowControls={() => setAccentDrillInOpen(true)}
            />
          )}
        </div>

        <div
          style={{
            marginTop: 16,
            flexShrink: 0,
            fontFamily: FONT,
            fontWeight: 300,
            fontSize: 11,
            color: 'rgba(234, 229, 239, 0.32)',
          }}
        >
          tap to toggle · hold + drag to set a level
        </div>
      </div>

      {hasFooter && (
        <div style={FOOTER_STYLE}>
          {acEntry && <ClimateCluster acEntry={acEntry} />}
          {receiverEntry && (
            <AvCluster
              receiverEntry={receiverEntry}
              projectorEntry={projectorEntry}
              inputScenes={inputScenes}
            />
          )}
          {spotifyEntry && (
            <NowPlaying
              spotifyEntry={spotifyEntry}
              receiverOn={receiverEntry ? receiverEntry.live && receiverEntry.live.power === 'ON' : true}
            />
          )}
        </div>
      )}

      {accentDrillInOpen && accentEntries.length > 0 && (
        <AccentDrillIn
          accentEntries={accentEntries}
          onBack={() => setAccentDrillInOpen(false)}
        />
      )}
    </div>
  );
}

export default RoomPanel;
