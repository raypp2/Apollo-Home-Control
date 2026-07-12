// Apollo v2 dashboard -- Room Command Panel.
//
// Right column: the room's device rows in a scrollable area, with the
// AV/climate/now-playing cluster PINNED to the bottom so it stays visible
// while the device list scrolls above it. The 6 DMX fixture lights are
// consolidated into a single AccentRow + drill-in; the office's webcam key
// light + hair light are consolidated into one expandable "Studio" GroupRow
// (see scenes/registry.js's DEVICE_GROUPS).
//
// The AV zone (living + kitchen + office) is one open-plan space with no
// walls, so the shared AC/Anthem/Spotify/projector controls appear for all
// three.
//
// Zone panels: rooms.json's `zone` field (e.g. "common" -- kitchen/dining/
// living/office) makes ui.selectedRoom hold the ZONE id whenever any member
// room is tapped (see ui.selectRoom). This panel detects that via
// store.zoneMembers and renders ONE shared panel for the whole space: the
// union of every member room's device rows (member order preserved, each
// member's rows visually grouped so a tap on the plane can scroll+flash just
// that section -- see the `focusRoom` effect below), and both member rooms'
// scene-pill presets (registry.roomScenesForZone) since a zone has no single
// scene of its own.
//
// Panel title: the room/zone's own name isn't shown here at all -- identity
// is already conveyed by which room lit up on the floorplan. Instead the
// title says what KIND of panel this is: "Lights & Devices" when it holds
// any non-light device (shade, receiver, spotify, AC...), else just
// "Lights". This applies uniformly to the zone panel and every plain room.

import { useEffect, useRef, useState } from 'preact/hooks';
import { store, ui, commands } from '../state/index.js';
import DeviceRow from './DeviceRow.jsx';
import ShadeRow from './ShadeRow.jsx';
import AccentRow from './AccentRow.jsx';
import AccentDrillIn from './AccentDrillIn.jsx';
import GroupRow from './GroupRow.jsx';
import ClimateCluster from '../climate/index.js';
import { AvCluster, NowPlaying, isSpotifyInputNumber } from '../av/index.js';
import { RoomToggle } from '../scenes/index.js';
import { roomScenesForZone, resolveEntry, DEVICE_GROUPS } from '../scenes/registry.js';
import { SceneMacroButton } from '../scenes/Button.jsx';
import './panel.css';

const PANEL_KINDS = new Set(['dim', 'switch', 'color', 'shade']);
const FONT = "'Outfit', system-ui, sans-serif";
// Open-plan zone that shares the living room's AV + climate hardware. Every
// member of the "common" zone (kitchen/dining/living/office) now resolves to
// the "common" zone id before it ever reaches this component (see
// ui.selectRoom), so "common" is what actually needs to match here; the
// individual member ids are kept for defensiveness only.
const AV_ZONE = new Set(['living', 'kitchen', 'office', 'common']);

/** "KITCHEN" -> "Kitchen"; used only for RoomToggle's own internal "<room>
 * lights" label on a plain room -- the panel's own title no longer shows the
 * room name at all (see the `title` doc below). */
function titleCase(label) {
  if (!label) return '';
  return label
    .toLowerCase()
    .split(' ')
    .map((word) => (word ? word[0].toUpperCase() + word.slice(1) : word))
    .join(' ');
}

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

/**
 * Collapses a flat device-row list into render rows, folding any
 * DEVICE_GROUPS members into a single group row at the position of whichever
 * member appears first in `entries` (task 6's "Studio" group -- webcam key
 * light + hair light -- today; data-driven for any future group).
 * @param {Array<object>} entries - panel-kind device entries (dim/switch/
 *   color/shade), already filtered/ordered by the caller
 * @returns {Array<{kind:'device',entry:object}|{kind:'group',group:object,entries:Array<object>}>}
 */
function buildPanelRows(entries) {
  const consumedIds = new Set();
  const rows = [];
  for (const entry of entries) {
    if (consumedIds.has(entry.id)) continue;
    const group = DEVICE_GROUPS.find((g) => g.members.includes(entry.id));
    if (group) {
      const memberEntries = group.members
        .map((id) => entries.find((e) => e.id === id))
        .filter(Boolean);
      memberEntries.forEach((e) => consumedIds.add(e.id));
      rows.push({ kind: 'group', group, entries: memberEntries });
      continue;
    }
    rows.push({ kind: 'device', entry });
  }
  return rows;
}

/** The plain room id a render row belongs to (device's own `room`, or a
 * group's declared `room`) -- used to bucket rows into zone-member sections. */
function rowRoom(row) {
  return row.kind === 'group' ? row.group.room : row.entry.room;
}

function renderRow(row) {
  if (row.kind === 'group') {
    return <GroupRow key={row.group.id} group={row.group} entries={row.entries} />;
  }
  const kind = commands.kindOf(row.entry);
  const key = row.entry.stateTopic || row.entry.id;
  return kind === 'shade'
    ? <ShadeRow key={key} entry={row.entry} />
    : <DeviceRow key={key} entry={row.entry} />;
}

function RoomPanel() {
  const selectedRoom = ui.selectedRoom.value;
  const focus = ui.focusRoom.value;
  const [accentDrillInOpen, setAccentDrillInOpen] = useState(false);
  // roomId -> DOM node for each zone-member's device-row section, so the
  // focusRoom effect below can scroll + flash the right one. Persists across
  // renders (a plain object keyed fresh each render pass, not a signal --
  // this is DOM bookkeeping, not view state).
  const sectionRefs = useRef({});

  // Close the drill-in on room change so switching rooms never leaves a
  // stale overlay open over a different room's controls.
  useEffect(() => {
    setAccentDrillInOpen(false);
  }, [selectedRoom]);

  // Zone-member tap -> scroll that member's section into view and flash it
  // (see ui.js's `focusRoom` doc). Guarded on `sectionRefs.current[...]`
  // existing since a stale focusRoom tick can arrive for a room that isn't
  // part of whatever's currently selected (e.g. selection changed again
  // before this effect ran).
  useEffect(() => {
    if (!focus) return undefined;
    const el = sectionRefs.current[focus.roomId];
    if (!el) return undefined;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    // Restart the animation even on a re-tap of the same member: remove the
    // class, force a reflow, then re-add it.
    el.classList.remove('member-flash');
    void el.offsetWidth;
    el.classList.add('member-flash');
    const timer = setTimeout(() => el.classList.remove('member-flash'), 1500);
    return () => clearTimeout(timer);
  }, [focus]);

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
  const roomLabel = isZone ? '' : titleCase(room ? room.label : selectedRoom);

  const roomDevices = store.devicesInZoneOrRoom(selectedRoom);
  const accentEntries = roomDevices.filter((entry) => entry.type === 'dmxFixture');
  const entries = roomDevices
    .filter((entry) => entry.type !== 'dmxFixture')
    .filter((entry) => PANEL_KINDS.has(commands.kindOf(entry)));
  const panelRows = buildPanelRows(entries);

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

  // Task 4: the now-playing drawer only opens while the receiver is ON and
  // its current input is the Spotify one (live.input matches the number
  // AvCluster's INPUT_NUMBER_TO_SCENE_ID maps to the Spotify device scene).
  const receiverLive = (receiverEntry && receiverEntry.live) || {};
  const receiverOn = receiverLive.power === 'ON';
  const spotifyOpen = Boolean(spotifyEntry && receiverOn && isSpotifyInputNumber(receiverLive.input));

  // Task 2: the title says what KIND of panel this is, not which room --
  // "Lights & Devices" once it holds any non-light device (a shade row, or
  // the AC/receiver/Spotify footer), else just "Lights". DMX accent fixtures
  // don't count -- they're lights too, just consolidated into AccentRow.
  const hasNonLightDevice = Boolean(hasFooter) || entries.some((e) => commands.kindOf(e) === 'shade');
  const title = hasNonLightDevice ? 'Lights & Devices' : 'Lights';

  // Zone panel only: a "common" zone has no single scene of its own, so show
  // every member room's scene-pill preset (living, office today) as a
  // shortcut within the shared space.
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
          {title}
        </div>

        {/* Task 1: the zone's old master "Common lights" row is gone entirely
            (not providing value, per Ray) -- plain rooms keep their existing
            >1-light gate (which effectively never fires today, since every
            multi-light room is itself a zone member -- kept as-is). */}
        {!isZone && commands.roomLights(selectedRoom).length > 1 && (
          <div style={{ marginBottom: 16 }}>
            <RoomToggle roomId={selectedRoom} roomLabel={roomLabel} />
          </div>
        )}

        {zoneScenes.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
            {zoneScenes.map(({ mapping, entry }) => (
              <SceneMacroButton key={mapping.id} kind={mapping.kind} entry={entry} />
            ))}
          </div>
        )}

        {isZone ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {zoneMembers.map((member) => {
              const memberRows = panelRows.filter((row) => rowRoom(row) === member.id);
              const memberAccents = accentEntries.filter((e) => e.room === member.id);
              if (memberRows.length === 0 && memberAccents.length === 0) return null;
              return (
                <div
                  key={member.id}
                  ref={(el) => { sectionRefs.current[member.id] = el; }}
                  className="panel-member-section"
                >
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
                    {memberRows.map(renderRow)}
                    {memberAccents.length > 0 && (
                      <AccentRow
                        entries={memberAccents}
                        onShowControls={() => setAccentDrillInOpen(true)}
                      />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
            {panelRows.map(renderRow)}
            {accentEntries.length > 0 && (
              <AccentRow
                entries={accentEntries}
                onShowControls={() => setAccentDrillInOpen(true)}
              />
            )}
          </div>
        )}

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
            <NowPlaying spotifyEntry={spotifyEntry} open={spotifyOpen} />
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
