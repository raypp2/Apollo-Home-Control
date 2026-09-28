// Apollo "next" preview layout -- Lights tab: the selected room/zone's light
// entries as a 2-column tile grid (see Tile.jsx). Mirrors
// panel/RoomPanel.jsx's device gathering + folding rules exactly (same
// PANEL_KINDS-equivalent filter via commands.kindOf, same DEVICE_GROUPS fold,
// same dmxFixture -> single Accent tile fold) so this tab and the classic
// panel never disagree about what a room "has". RoomPanel doesn't export its
// `buildPanelRows` helper, so it's duplicated here in the same shape rather
// than reached into.
//
// In a zone (rooms.json's `zone` field, e.g. "common"), tiles are grouped
// under an uppercase heading per member room (LIVING / OFFICE / KITCHEN /
// DINING), each heading spanning both grid columns -- no collapsing, unlike
// RoomPanel's zone sections this stays a flat list of always-visible
// sections. Tapping a zone member on the plane (ui.focusRoom) scrolls that
// member's heading into view within the tab's own scroll region.

import { useEffect, useRef, useState } from 'preact/hooks';
import { store, ui, commands } from '../state/index.js';
import { DEVICE_GROUPS } from '../scenes/registry.js';
import Tile from './Tile.jsx';
import TileSheet from './TileSheet.jsx';

const LIGHT_KINDS = new Set(['dim', 'switch', 'color']);

/**
 * Collapses a flat light-entry list into render rows, folding any
 * DEVICE_GROUPS members into a single group row -- exact analog of
 * RoomPanel.jsx's buildPanelRows.
 * @param {Array<object>} entries
 * @returns {Array<{kind:'device',entry:object}|{kind:'group',group:object,entries:Array<object>}>}
 */
function buildTileRows(entries) {
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

function rowRoom(row) {
  return row.kind === 'group' ? row.group.room : row.entry.room;
}

function deviceTileProps(entry, openSheet) {
  const view = commands.deviceView(entry);
  const isColor = view.kind === 'color';
  const isDim = view.kind === 'dim' || isColor;
  return {
    key: entry.stateTopic || entry.id,
    name: shortTitle(view.title),
    // A light that's on is never "0%": Hue reports its dimmest step (bri 1
    // of 254) as a fraction of a percent, which rounds down to 0.
    value: isDim ? (view.on ? `${Math.max(1, view.level)}%` : 'Off') : (view.on ? 'On' : 'Off'),
    on: view.on,
    level: isDim ? (view.on ? Math.max(1, view.level) : 0) : null,
    color: isColor && view.on ? view.color : null,
    dimmed: view.reachable === false || view.stale,
    pending: view.unconfirmed,
    hasMore: isDim,
    // Only a single dim/color light gets the press-and-hold-then-slide dim
    // gesture (see Tile.jsx) -- groups/Accent keep the plain hold->sheet.
    dimmable: isDim,
    commitMode: view.commit,
    onDimPreview: (val) => commands.previewLevel(entry, val),
    onDimCommit: (val) => commands.commitLevel(entry, val),
    onTap: () => commands.toggle(entry),
    // Store only the identifier, not the entry object itself -- the store
    // replaces device entry objects on every MQTT update, so holding the
    // object here would freeze the sheet on a stale snapshot (the live
    // entry is re-resolved from `entries` on every render, see resolveSheet
    // below).
    onOpenSheet: () => openSheet({ type: 'device', stateTopic: entry.stateTopic }),
  };
}

/** "Living Room - Couch" -> "Couch": the section heading already names the
 * room, and the long form collides with the tile's › button on phones. */
function shortTitle(title) {
  const i = title.indexOf(' - ');
  return i > 0 ? title.slice(i + 3) : title;
}

function groupTileProps(group, entries, openSheet) {
  const onCount = entries.filter((e) => commands.isOn(e)).length;
  return {
    key: group.id,
    name: group.title,
    value: `${onCount} of ${entries.length} on`,
    on: onCount > 0,
    level: null,
    color: null,
    dimmed: false,
    hasMore: true,
    onTap: () => commands.groupToggle(entries),
    // See deviceTileProps: identifier only, resolved live via resolveSheet.
    onOpenSheet: () => openSheet({ type: 'group', groupId: group.id }),
  };
}

function accentTileProps(accentEntries, openSheet, keySuffix) {
  const anyOn = accentEntries.some((e) => commands.deviceView(e).on);
  return {
    key: `accent-${keySuffix}`,
    name: 'Accent',
    value: anyOn ? 'On' : 'Off',
    on: anyOn,
    level: null,
    color: null,
    dimmed: false,
    hasMore: true,
    // Mirrors AccentRow: tapping while any fixture is on turns them all off.
    // With everything off there's no single "on" state to restore, so the
    // tap opens the preset sheet instead of doing nothing.
    onTap: () => {
      if (!anyOn) {
        openSheet({ type: 'accent', ids: accentEntries.map((e) => e.stateTopic) });
        return;
      }
      accentEntries.forEach((entry) => {
        if (commands.deviceView(entry).on) commands.toggle(entry);
      });
    },
    // See deviceTileProps: identifiers only, resolved live via resolveSheet.
    onOpenSheet: () => openSheet({ type: 'accent', ids: accentEntries.map((e) => e.stateTopic) }),
  };
}

/**
 * Resolves a sheet descriptor (stateTopic/groupId/ids only, see the
 * `onOpenSheet` calls above) into the live entry/entries TileSheet renders,
 * looked up fresh from this render's `entries`/`accentEntries` -- never from
 * a snapshot captured when the sheet was opened. This is what keeps the
 * sheet's brightness bar (and group members' rows) tracking live MQTT state
 * instead of freezing on the device's state at open time.
 * @param {null|{type:'device',stateTopic:string}|{type:'group',groupId:string}|{type:'accent',ids:string[]}} sheet
 * @param {Array<object>} entries
 * @param {Array<object>} accentEntries
 */
function resolveSheet(sheet, entries, accentEntries) {
  if (!sheet) return null;
  if (sheet.type === 'device') {
    const entry = entries.find((e) => e.stateTopic === sheet.stateTopic);
    return entry ? { type: 'device', entry } : null;
  }
  if (sheet.type === 'group') {
    const group = DEVICE_GROUPS.find((g) => g.id === sheet.groupId);
    if (!group) return null;
    const memberEntries = group.members.map((id) => entries.find((e) => e.id === id)).filter(Boolean);
    return { type: 'group', group, entries: memberEntries };
  }
  if (sheet.type === 'accent') {
    const liveAccentEntries = accentEntries.filter((e) => sheet.ids.includes(e.stateTopic));
    return { type: 'accent', accentEntries: liveAccentEntries };
  }
  return null;
}

/**
 * Drops empty member sections and folds runs of consecutive one-tile
 * sections into one ("KITCHEN · DINING"), so a single light doesn't leave
 * half of a two-column row empty under its own heading.
 * @param {Array<{ids:string[],label:string,rows:Array,accents:Array}>} sections
 */
function mergeSparseSections(sections) {
  const tileCount = (s) => s.rows.length + (s.accents.length > 0 ? 1 : 0);
  const out = [];
  for (const section of sections) {
    if (tileCount(section) === 0) continue;
    const prev = out[out.length - 1];
    if (prev && prev.single && tileCount(section) === 1) {
      prev.ids = [...prev.ids, ...section.ids];
      prev.label = `${prev.label} · ${section.label}`;
      prev.rows = [...prev.rows, ...section.rows];
      prev.accents = [...prev.accents, ...section.accents];
      prev.single = false;
      continue;
    }
    out.push({ ...section, single: tileCount(section) === 1 });
  }
  return out;
}

function renderTile(row, openSheet) {
  if (row.kind === 'group') {
    return <Tile {...groupTileProps(row.group, row.entries, openSheet)} />;
  }
  return <Tile {...deviceTileProps(row.entry, openSheet)} />;
}

export default function LightsTab() {
  const selectedRoom = ui.selectedRoom.value;
  const focus = ui.focusRoom.value;
  const [sheet, setSheet] = useState(null);
  const sectionRefs = useRef({});

  // Close any open sheet on room change, same rationale as RoomPanel's
  // accentDrillInOpen reset.
  useEffect(() => {
    setSheet(null);
  }, [selectedRoom]);

  // Zone-member tap (from the plane) -> scroll that member's heading into
  // view within this tab's own scroll region. Mirrors RoomPanel's focusRoom
  // effect.
  // Skip the focus that's already set when the tab mounts (the default-room
  // selection on load, or a tap made while another tab was showing) -- only
  // a plane tap made while this tab is open should scroll the list.
  const initialFocus = useRef(focus);
  useEffect(() => {
    if (!focus || focus === initialFocus.current) return undefined;
    const el = sectionRefs.current[focus.roomId];
    if (!el) return undefined;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    el.classList.remove('member-flash');
    void el.offsetWidth;
    el.classList.add('member-flash');
    const timer = setTimeout(() => el.classList.remove('member-flash'), 1500);
    return () => clearTimeout(timer);
  }, [focus]);

  if (!selectedRoom) {
    return <div class="next-empty">Tap a room to control it</div>;
  }

  const zoneMembers = store.zoneMembers(selectedRoom);
  const isZone = zoneMembers.length > 0;

  const roomDevices = store.devicesInZoneOrRoom(selectedRoom);
  const accentEntries = roomDevices.filter((entry) => entry.type === 'dmxFixture');
  const entries = roomDevices
    .filter((entry) => entry.type !== 'dmxFixture')
    .filter((entry) => LIGHT_KINDS.has(commands.kindOf(entry)));
  const rows = buildTileRows(entries);

  if (entries.length === 0 && accentEntries.length === 0) {
    return <div class="next-empty">No lights in this room</div>;
  }

  return (
    <div class="next-lights-tab">
      {isZone ? (
        mergeSparseSections(zoneMembers.map((member) => ({
          ids: [member.id],
          label: (member.label || member.id).toUpperCase(),
          rows: rows.filter((row) => rowRoom(row) === member.id),
          accents: accentEntries.filter((e) => e.room === member.id),
        }))).map((section) => (
          <div
            key={section.ids.join('+')}
            ref={(el) => { section.ids.forEach((id) => { sectionRefs.current[id] = el; }); }}
            class="next-member-section"
          >
            <div class="next-member-heading">{section.label}</div>
            <div class="next-tile-grid">
              {section.rows.map((row) => renderTile(row, setSheet))}
              {section.accents.length > 0 && (
                <Tile {...accentTileProps(section.accents, setSheet, section.ids.join('+'))} />
              )}
            </div>
          </div>
        ))
      ) : (
        <div class="next-tile-grid">
          {rows.map((row) => renderTile(row, setSheet))}
          {accentEntries.length > 0 && (
            <Tile {...accentTileProps(accentEntries, setSheet, selectedRoom)} />
          )}
        </div>
      )}

      <TileSheet sheet={resolveSheet(sheet, entries, accentEntries)} onClose={() => setSheet(null)} />
    </div>
  );
}
