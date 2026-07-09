# Stage 11 — Dashboard Redesign ("Beacon v3")

Sub-plan required by `mqtt-implementation-plan.md` Stage 11. Implements the approved
design direction from the *Apollo dashboard design brief* handoff (section `#t3`,
option 3a), reconciled against what the backend can actually do.

**Status:** planned, not started.
**Design source:** `Apollo Explorations.dc.html` §`#t3`, `README.md` (handoff), `floorplan.jpg`.
**Pulls in:** MQTT plan Stage 12 (color), partially — Hue only.

---

## 1. The central problem

The design was authored against a device inventory and a capability set that the system
does not have. Fidelity is "high" and diagnostics are "mocked," but much of it is mocked
because the capability is absent, not because the data was inconvenient to fake.

| Design assumes | Reality | Resolution |
|---|---|---|
| Color swatches on Giant P / Bedroom Color | `hue_group_command()` builds `GroupLightState().on()/.off()/.brightness()` only. No color command, no capability flag, no `color` in MQTT state. | **Build it.** Hue only (§4.3). |
| AV drill-in: sound mode, speakers A/B, Zone 2, bass/treble, sub trim, lip sync, pure direct | `devices.json` `anthem` exposes on/off, `vol_up/down(_x3)`, `muteToggle`, 4 inputs, `volumeValue`, `volumeQuery`, `input_query`. ~15% of the drill-in exists. | **Ship the confirmed subset.** No fictional controls (§4.5). |
| AV diagnostics: model, signal in, output, temp, uptime, last error | None exposed. | **Replace with real diagnostics** from `/api/health` + MQTT (§4.5). |
| AV actions: reboot, speaker test, network check | Don't exist. | **Replace** with the three real query commands. |
| Climate: absolute setpoint 60–80°, Cool/Heat/Fan/Dry/Auto, fan speed, swing | `livingRoomAC` is `iTach_ir` — one-way IR. `temp_increase`/`temp_decrease` are *relative*. Modes are `COOL` and `ECO`. Fan speed is relative only. No swing. Zero readback. | **Apollo-side shadow state** with manual override (§4.4). |
| Climate diagnostics: room temp, humidity, coil temp, compressor, filter life, refrigerant | None exist. IR is write-only. | **Replace** with shadow-state inspector + override form. |
| Volume drag bar with a live value | `tcpServers.js` publishes `power` only. | **Add volume/input/mute state** (§4.5). |
| "Accent" = one fixture, one preset at a time | Six `dmxFixture` lights across **two** physical fixtures: `adj` (Ceiling, Webcam Back) and `spot` (Deer, End Table, Coffee Table, Mirror Ball). Ceiling and Deer can be on simultaneously. | **Picker as designed** in the panel; a drill-in exposes both fixtures honestly (§5.4). |
| Rooms as primary navigation | **Nothing maps devices → rooms.** `location` exists on 4 shelly lights + shades and is load-bearing for MQTT topic construction. | **New `config/rooms.json` + `room` field**, leaving `location` untouched (§4.1). |
| Scene pills as exclusive radio | Scenes publish no state at all. | **Scene shadow state** on MQTT, independent (non-radio) actives (§4.2). |
| 5 scene pills | 12 lightingScenes + 5 macros, with 3 name collisions across the two files. | **Tiered scene model** (§4.2). |
| Panel rows for lights only | Brief *requires* shade control. Projector, door buzzer, Find My iPhone also have no home in `#t3`. | **Shades → panel row; rest → utility rail / AV cluster** (§5.5). |

Two lights the design omits entirely — `siren-light` (shelly, office) and `webcam-back`
(DMX, `adj` fixture, a **living-room** fixture) — are added back. The `bath` and `guest` rooms on
the floorplan have zero devices; they render as **non-selectable** (drawn on the plan for spatial
context, but inert — no hover target, no panel).

---

## 2. Decisions taken

Recorded from the intake conversation, 2026-07-08.

1. **Scope:** full design including drill-ins. Pulls Hue color forward from Stage 12.
2. **Stack:** Preact + Vite. Deploy grows a build step.
3. **Scenes:** tiered — default-visible set, one *consolidated* More menu (not one per class),
   room-scoped scenes surfacing in the room panel, DMX-specific scenes demoted to device controls.
   **Rule: when a lightingScene and a macro share a title, the macro fires.**
4. **Scene state:** reconciled via Apollo-side shadow status. Apollo is the only scene controller.
5. **Accent:** single preset picker as designed, plus a "show controls" drill-in exposing both
   physical fixtures and their full preset sets.
6. **Homeless devices:** Shades → Living Room panel row (0–100% position bar). Projector → AV cluster.
   Door + Find My iPhone → persistent utility rail.
7. **Climate:** Apollo shadow state for setpoint, mode, *and* fan speed. Manual override of any
   value rather than an auto-calibration routine. The physical unit is rarely touched, so the
   shadow is assumed authoritative.
8. **AV input:** the INPUT buttons fire the full deviceScene (`/api/DEVICESCENES/appleTv/on`) —
   receiver input + video device + keypad blink, one tap.
9. **Anthem drill-in:** confirmed command subset only (input / volume / mute). Diagnostics fed from
   `/api/health` and MQTT. No dead buttons.
10. **Migration:** new dashboard at `/`, AngularJS UI preserved at `/legacy`, linked from the
    status screen. Removed once the new one is proven.
11. **Fixture positions:** accept the design's guesses. All plan geometry lives in
    `config/rooms.json` as data — never hardcoded in components — so repositioning is a JSON edit.
12. **Drag commit:** per-protocol capability. Insteon commits on pointer-up. Hue/DMX may commit live.
13. **Spotify art:** fetched from `i.scdn.co`, no local cache. (If the internet is down, nothing is playing.)
14. **WLED `office-bookshelf`:** ordinary on/off light. Its color capability is deferred to Stage 12.
15. **Admin links** (DMX, Homebridge, PM2, Uptime Kuma, log viewer, `/legacy`) live in the status screen.
16. **Plex + Jellyfin:** link-out chips in the Living Room group, with product logos. Not device rows.
    A richer Plex integration is future work.
17. **Fonts:** Outfit vendored into `public/font/`, matching how Roboto and the JS libs are already
    vendored. No Google Fonts CDN.

---

## 3. Architecture

### 3.1 Build and deploy

```
web/                     # new — Vite + Preact source
  src/
  index.html
  vite.config.js
public/app/              # build output (gitignored, rsynced)
public/legacy/           # the current AngularJS UI, moved
```

- `npm run build` → `public/app/`. `npm run dev` → Vite dev server proxying `/api`, `/list` to `localhost:80`.
- `public/app/` is **gitignored** but **not** rsync-excluded — `private/update-pi.sh` gains a
  `npm run build` step before the rsync, so the Pi never builds. `rsync --delete` keeps it in sync.
- `webServer.js` route order becomes: `/api/health` → `/api/*` → `/list/*` → `express.static('public')`
  with `/` rewritten to `public/app/index.html`, and `/legacy` → `public/legacy/index.html`.
  Moving the old UI into `public/legacy/` is what frees `/` (today `express.static` serves
  `public/index.html` there implicitly).

### 3.2 Data flow

```
bootstrap:  GET /api/health   → per-device topic, full last state, age, staleness, bridges, degraded
            GET /list/rooms   → NEW: plan geometry, fixture positions, device membership
            GET /list/{lights,devices,lightingScenes,macros,deviceScenes}
                              → titles, capabilities, icons, + NEW `stateTopic` per entry

live:       ws://<host>:9001  (Mosquitto websockets listener)
            apollo/+/+/+/state          device state
            apollo/health/#             per-device staleness + summary
            apollo/bridge/+/status      apollo, hue-sse
            apollo/home/scene/+/state   NEW
            apollo/home/macro/+/state   NEW
            apollo/home/spotify/player/state   (matches the +/+/+ filter)

command:    POST /api/<MODULE>/<DEVICE>/<COMMAND>/<P1>/<P2>   fire-and-forget, unchanged
```

**Delete the client-side ecosystem table.** `public/js/mqttDashboard.js:65-77` hand-duplicates
`src/mqttTopics.js:74-86` with no build step keeping them in sync. Instead the server emits the
canonical `stateTopic` on every `/list/*` entry. The browser never reconstructs a topic again.

### 3.3 Optimistic state and reconciliation

Commands are fire-and-forget; MQTT corrects later. The current UI simply lets `ng-model` flip and
hopes. The new store does:

1. Apply the optimistic value locally, tagged `pending` with a deadline (default 4s).
2. On a matching MQTT state message, clear `pending` and take the authoritative value.
3. On deadline expiry, revert to last-known state and mark the device `degraded` in the UI
   (dot goes hollow, status strip trace records the failure).

Insteon round-trip is slow enough that this matters. DMX and WLED publish **no** state at all
(`mqttTopics.js:89-92`), so their optimistic value is permanent until the next command — the store
must treat "never publishes state" as a device class, not as a timeout.

### 3.4 Drag commit policy

Per-entry, declared in config, defaulting by ecosystem:

```json5
{ "id": "kitchen", "type": "insteon", "dragCommit": "release" }   // one command on pointer-up
{ "id": "giantP",  "type": "hue-group", "dragCommit": "live" }    // throttled to ~10/s during drag
```

The plan's fixture dot and the row's fill bar animate continuously from local state regardless;
only the wire traffic differs. Insteon defaults to `release`, everything else to `live`.

---

## 4. Backend work

### 4.1 Room model

**New `config/rooms.json`** (JSON5, gitignored personal + committed `.example`) — presentation data only:

```json5
[
  {
    "id": "living",
    "label": "LIVING",
    "rect": { "x": 202, "y": 175, "w": 266, "h": 268 },
    "furniture": [ /* the design's furn3 entries, verbatim */ ],
    "fixtures": {                    // deviceId → position, relative to room rect
      "livingRoomBookshelf": { "x": 22,  "y": 170 },
      "livingRoomCouch":     { "x": 214, "y": 88  },
      "giantP":              { "x": 238, "y": 230 },
      "led-art-wall":        { "x": 120, "y": 10  },
      "accent":              { "x": 162, "y": 130 }   // the virtual preset device
    },
    "acUnit": { "x": 0, "y": 0, "facing": "n" },      // design draws it on the dining wall; corrected
    "links": [ "plex", "jellyfin" ]
  }
]
```

**New `"room": "<roomId>"` field** on each entry in `lights.json` and `devices.json`.

> **Why not reuse `location`?** `mqttTopics.js:141` builds `apollo/<location>/<ecosystem>/<name>/<attr>`
> from it. Only 4 shelly lights + `shades` set it; everything else silently lands under `home`.
> Backfilling `location` would rewrite the state topic for 16 lights — orphaning their retained
> state, changing what Homebridge's mqttthing accessories and the Alexa shadow mirror subscribe to.
> `room` is a presentation concept; `location` is a wire concept. They are deliberately separate.
> Document this in `CLAUDE.md` so the next reader doesn't "clean it up."

**New `GET /list/rooms`** returning the parsed rooms config. **`stateTopic` added** to every
`/list/*` entry, computed server-side via `mqttTopics.topicFor(entry, 'state')`.

Room membership:

| Room | Devices |
|---|---|
| kitchen | `kitchen` |
| dining | `diningRoom` |
| living | `livingRoomBookshelf`, `livingRoomCouch`, `giantP`, `led-art-wall`, **accent** (virtual), `shades`, `theaterProjector`, `anthem`, `livingRoomAC`, `lrEchoSpotify`, deviceScenes `appleTv`/`chromeCast`/`spotifyServerLivingRoom`, link chips Plex + Jellyfin |
| office | `officeDesk`, `officeWall`, `office-bookshelf`, `webcam`, `hair-light`, `siren-light` |
| hall | `hall` |
| master | `bedroomColor` |
| bath, guest | *(none — drawn for context, non-selectable/inert)* |
| — (utility rail) | `door`, `findMyIphone` |

### 4.2 Scene shadow state

Apollo is the only thing that ever activates a scene or macro — Alexa (SQS), the Insteon keypad
listener, and the dashboard all route through `handleRequest`. So an activation record is accurate
at the moment it is written.

Scenes are expressed as opaque hub-side handles — `insteon_group`, `hue_scene` (GUIDs), `hue_group`
([config/lightingScenes.json](../config/lightingScenes.json)). Apollo fires "activate group 12" and
the PLM / Hue bridge sets member devices to levels programmed *in the hardware*. The config never
enumerates which devices a scene touches or to what level. So Apollo has no static membership map.

**Reconciliation by learned fingerprint** (supersedes an `active`-boolean model). Because Apollo
already monitors every device's state over MQTT, it can *learn* a scene's fingerprint by observing
what activation produces, then flag divergence when a member later drifts:

1. **Activate → settle → snapshot.** On `scene_command(id, 'on')`, wait for a settle window (Insteon
   ramps ~1–2s; the poll sweep adds latency — debounce ~3s, extended by any state message arriving
   within it), then snapshot the current per-device MQTT state. **Membership auto-derives**: the
   members are exactly the devices whose state changed across activation (diff pre vs post).
2. **Store the fingerprint** as retained JSON (below). It is "what these devices actually were the
   last time this scene ran" — honest, and self-healing against hub reprogramming since every
   activation refreshes it.
3. **Detect drift.** On any subsequent device state message, compare against every fingerprint whose
   member set includes that device. Brightness compares with a tolerance band (±3, Insteon reported
   levels round). A member outside tolerance flips that scene `active → false` and republishes.

**New retained topics:**

```
apollo/home/scene/<sceneId>/state
  {"active": true, "activatedAt": 1751990400,
   "fingerprint": {"apollo/home/insteon/kitchen/state": {"power":"ON","brightness":60},
                   "apollo/home/hue/giantP/state": {"power":"ON","brightness":100,"color":"#a688e8"}},
   "source": "command"}
apollo/home/macro/<macroId>/state
  {"active": false, "activatedAt": 1751990400, "source": "command"}
```

**Not exclusive.** `allLights` and `livingRoom` can be active simultaneously — each tracks its own
`active`. Two scenes sharing a device (e.g. `movie-mode` and `bedtime` both use `insteon_group:"10"`
but differ in Hue scenes) are distinguished because their *fingerprints* differ, where an
"active group" model could not tell them apart.

**Declared blind spots** (see §9 / backlog):
- **DMX and WLED publish no state** ([mqttTopics.js:89-92](../src/mqttTopics.js:89)). Scenes touching
  those fixtures (`movie-mode`, `mirrorball`, the DMX-heavy ones) can be reconciled on their
  Insteon/Hue members only; DMX members are invisible to the fingerprint. Bounded and known — the UI
  should not claim certainty for a scene whose fingerprint is partial.
- **Color, until §4.3 lands.** A Hue scene that changes only color at equal brightness is invisible
  to a fingerprint that predates color state. Closes for the two Hue lights once §4.3 ships.

**Macros** have no meaningful device fingerprint (they interleave scene calls, device commands, and
timing), so they keep the simple `active` boolean set on `on` / cleared on `off` — last-activation,
not reconciled. Retained topics mean both survive an Apollo restart; the store trusts the retained
`active` until its first live fingerprint comparison completes.

**Tiered scene model:**

| Tier | Contents |
|---|---|
| Default bar | Hangout Mode *(scene)*, All Lights *(scene)*, Bedtime *(macro)*, Studio *(macro)*, Ray's Music *(macro)* |
| Room panel scene bar | Living Room *(scene)* → living; Office *(scene)* → office |
| Accent device drill-in | Wolf, Mirror Ball, DMX Manual *(scenes)* |
| Consolidated More menu | Away *(macro)*, Movie Mode *(macro)*, and anything not placed above |
| Hidden | `button-a`, `button-b` — Insteon keypad LED blink helpers referenced by `deviceScenes[].blinkButton`. Internal plumbing, not user-facing. |

Collision rule, applied uniformly: **Bedtime, Away, and Movie Mode fire the macro, not the
lightingScene.** The scene of the same name becomes unreachable from the UI, which is correct —
the macro invokes it.

Visual distinction from the design survives: scenes are pills, macros are dashed-amber buttons.
Only the *More* menu is consolidated across both classes.

### 4.3 Hue color (Stage 12, partial)

Scope: `giantP` (hue-group 5) and `bedroomColor` (hue-group 3). WLED deferred.

- **Config:** new `"isColor": true` under the `alexa` capability block (sits beside `isDimmable`),
  or a top-level `"capabilities": ["dim","color"]`. Prefer the latter — `alexa.isDimmable` is
  already overloaded as the UI's dimmable flag, which is a smell worth not extending.
- **Command:** `/api/LIGHTS/<id>/COLOR/<hex>`.
  > `handler.js:63-68` splits on `/` and uppercases every segment, and `#` is a URL fragment
  > delimiter. Hex travels **without** the hash: `/api/LIGHTS/giantP/COLOR/A688E8`.
- **Driver:** `lightingPhilipsHue.js` — `hue_group_command()` currently branches ON / OFF / numeric
  after `.toUpperCase()`. Add a `COLOR` branch building `new GroupLightState().on().rgb(r,g,b)`.
  Setting a color implies power on, per the design.
- **State:** `publishState(entry, { power:'ON', color:'#a688e8' }, 'command')`. `mqttTopics.publishState`
  already merges rather than replaces (`mqttTopics.js:192-198`), so `color` accumulates alongside
  `power`/`brightness` without further work.
- **Readback:** `lightingPhilipsHueListener.js` (SSE) should publish `color` on change, so the
  swatch reflects a change made from the Hue app.
- **Alexa:** out of scope here. The shadow mirror will carry `color` as an extra reported field;
  the skill ignores unknown fields.

Swatches: `#f2a65e #e86a6a #a688e8 #6ab5e8 #7ed9a0 #e8d36a`, per the design. Selected gets an
`#eae5ef` ring. Picking a color turns the light on and tints its plan dot + row fill.

### 4.4 Climate shadow state

`livingRoomAC` is `iTach_ir`. Every command is a one-way IR blast with no acknowledgement. Apollo
must therefore *remember* what it believes the unit is set to.

**New `shadow` block** in `devices.json` for the AC, declaring the value domains and how to reach them:

```json5
"shadow": {
  "power":    { "type": "bool", "commands": { "on": "on", "off": "off" } },
  "mode":     { "type": "enum", "options": ["COOL", "ECO"], "commands": { "COOL": "COOL", "ECO": "ECO" } },
  "setpoint": { "type": "int",  "min": 60, "max": 80, "step": 1,
                "commands": { "up": "temp_increase", "down": "temp_decrease" } },
  "fan":      { "type": "enum", "options": ["auto", "low", "med", "high"],
                "commands": { "auto": "fan_auto", "up": "fan_speed_increase", "down": "fan_speed_decrease" } }
}
```

- **Absolute → relative translation:** setting setpoint 74 when the shadow says 70 fires
  `temp_increase` ×4, spaced by the iTach's existing inter-command delay. Same for `fan`, stepping
  through the ordinal list. `auto` is directly addressable, so `fan` snaps rather than steps when
  going to auto.
- **Manual override (Ray's ask):** the drill-in exposes every shadow value as directly editable
  *without sending IR* — "the unit is actually at 68 / ECO / low." Writing the override corrects the
  shadow silently. This is the recalibration mechanism, in place of an automatic slam-to-floor routine.
- **Persistence:** publish to the AC's existing state topic (`apollo/home/itach/livingRoomAC/state`)
  as retained JSON — `{power, mode, setpoint, fan}`. Survives restart via retained replay.
  > **Task:** `mqttTopics`'s merge cache (`lastState`, `mqttTopics.js:238`) is **not** seeded from
  > retained messages at boot — only `healthMonitor` subscribes to `apollo/+/+/+/state`. Add a boot-time
  > subscribe that seeds the cache, or the first post-restart publish will clobber the shadow with a
  > partial object. This is a real bug for the AC and a latent one for everything else.
- **Drift:** honest labelling. The drill-in's DIAGNOSTICS block reads *assumed* values, with
  "last commanded" timestamps and a note that no readback exists.

**Design blocks that get dropped:** Heat / Fan / Dry / Auto modes (only COOL and ECO exist), swing
(no command), room temp, humidity, coil temp, compressor, filter life, refrigerant (no sensors).
`sleep` and `timer` commands exist and get toggle chips.

### 4.5 Anthem receiver

**State (new).** `tcpServers.js` publishes `power` only. Add response parsing so the drill-in has
real values. **Protocol confirmed by live probe of the device 2026-07-08** (Mac reaches the Anthem
directly at port 14999 — not VLAN-isolated):

- A single connection accepts multiple queries and returns all responses concatenated in one packet.
  Sending `Z1POW?;Z1VOL?;Z1INP?;Z1MUT?;` returned `Z1POW1;Z1VOL-36;Z1INP5;Z1MUT0;`. So one poll
  round-trips the whole state — no per-attribute connection needed.
- **Parser:** split the buffer on `;`, match each token. Tolerate variable zero-padding: the *query
  response* is `Z1INP5` but the *set command* is `Z1INP05` ([devices.json](../config/devices.json)),
  and `Z1VOL-36`'s minus is part of the value. Regexes: `Z1POW([01])`, `Z1VOL(-?\d+)`,
  `Z1INP(\d+)`, `Z1MUT([01])`. Then `publishState(entry, { power, volume, input, mute }, 'poll')`.
- **Volume scale = integer negative dB, confirmed** (`Z1VOL-36` = −36 dB). `speaker.volumeValue` is
  `Z1VOL-<VOLUME>;` with a *hardcoded minus*, so Apollo can only address 0 → negative dB; it cannot
  reach 0 dB+. `alexaSpeaker.js:39-40` substitutes the value treating it as 0–100, which is really
  0..−100 dB — functional but mislabelled.
  > **Decision (was an open block):** the web drag bar is **dB-native**, not a fake percentage. Value
  > renders as `−36 dB`. Fill proportion = `(v − dbMin) / (dbMax − dbMin)` over a configurable window;
  > new config `volumeDbMin: -80`, `volumeDbMax: 0` (tune `dbMin` to taste — nobody listens below
  > ≈ −60). This matches the hi-fi/debug character and avoids inventing a percentage the device
  > doesn't have.
- **Input map** (number → source, from the confirmed command set): `1` Apple TV, `4` Chromecast,
  `5` Spotify Server, `6` Input 6. Input 5 in the probe = Spotify Server, consistent with the unit
  being on.

**Drill-in contents (real only):**

- Power pill (`Z1POW`).
- INPUT segmented: Apple TV, Chromecast, Spotify Server, Input 6. *(The panel's INPUT row fires the
  deviceScene; the drill-in's fires raw `input_*` commands — the drill-in is the debug surface,
  so it talks to the device directly.)*
- Main volume drag bar, dB-native (see above), disabled + 35% opacity when power is off, per the design.
- Toggle chip: Mute (`muteOn` `Z1MUT1` / `muteOff` `Z1MUT0`; state from `Z1MUT`).
- DIAGNOSTICS (real): IP:port, reachable, last seen (from `/api/health` `deviceDetail`), last state
  source, last command, last error. Monospace values, per the design's spec.
- ACTIONS (real): Power query, Volume query, Input query. Each echoes its parsed response into the
  status-strip trace — which is exactly the design's stated debug story, just with commands that exist.

**Dropped:** sound mode, speakers A/B, Zone 2 power + volume, bass, treble, subwoofer trim, lip sync,
pure direct, reboot, speaker test, network check. If the Anthem model turns out to expose these,
they slot into the same generic blocks with no UI work.

### 4.6 Spotify

- Flip `SPOTIFY_NOW_PLAYING=1` in `.env`. `index.js:167-170` explicitly says this stage is what
  unblocks it.
- Now-playing card consumes retained `apollo/home/spotify/player/state`:
  `{track, artist, albumArt, isPlaying, device}`.
- Album art loads directly from `i.scdn.co`. Add `referrerpolicy="no-referrer"` and a graceful
  fallback tile.
- **Transport — determined by reading `spotify.js` (was an open block):**
  - `spotifyStopPlay` → `spotifyApi.pause()` on the currently active device (`spotify.js:295`). Reusable
    directly as the now-playing card's **pause**.
  - `spotifySwitchPlay` → `transferMyPlayback([echo], {play:false})` then `spotifyApi.play(...)`
    (`spotify.js:213-234`). This **transfers** playback to the Living Room Echo and starts it — it is
    the "move playback to this room" action, *not* a lightweight resume. It always forces the Echo as
    the target.
  - **Therefore two distinct controls, not one:**
    - The device row `lrEchoSpotify` (on/off) keeps `spotifySwitchPlay`/`spotifyStopPlay` — "play here."
    - The now-playing card's **play/pause toggle** needs a lightweight resume that does *not*
      re-transfer. Pause reuses `spotifyStopPlay`. Resume is a **new** `spotifyResume()` calling
      `spotifyApi.play()` with no `device_id` (resumes on whatever device is active). Small addition to
      `spotify.js`; the token scope already permits it. Wire the card button to
      `/api/DEVICES/lrEchoSpotify/play|pause` (new command paths) rather than `on|off`, so the card
      controls transport without hijacking the active device.

### 4.7 System status screen

`/api/health` already returns everything: per-device `topic`, full last `state`, `ageSeconds`,
`stale`, `bridges`, `degraded`. Two fixes while we're here:

- `lastSeen` is in **milliseconds** and `timestamp` in **seconds** in the same object
  (`healthMonitor.js:340-360`). Normalise, or the frontend will get it wrong once.
- `apollo/bridge/+/status` is subscribed by the current dashboard and wired to nothing
  (`mqttDashboard.js:338-341`). Wire it.

The screen carries the admin links, per decision 15: DMX controller, Homebridge, PM2, Uptime Kuma,
log viewer, and `/legacy`.

---

## 5. Frontend

### 5.1 Module layout

```
web/src/
  state/       store.js  mqtt.js  api.js  bootstrap.js  optimistic.js
  plan/        Plane.jsx  Room.jsx  Furniture.jsx  Fixture.jsx  AcVent.jsx  Airflow.jsx
  topbar/      SceneBar.jsx  MoreMenu.jsx  MacroButton.jsx  UtilityRail.jsx
  panel/       RoomPanel.jsx  DeviceRow.jsx  ShadeRow.jsx  PresetRow.jsx
               ColorSwatches.jsx  LinkChip.jsx  RoomSceneBar.jsx
               ClimateCluster.jsx  AvCluster.jsx  NowPlaying.jsx
  drill/       AllControls.jsx  SegmentedGroup.jsx  DragBar.jsx  ToggleChip.jsx
               Diagnostics.jsx  Actions.jsx  OverrideForm.jsx
  status/      StatusStrip.jsx  StatusScreen.jsx
  phone/       BottomSheet.jsx
  tokens.css
```

The drill-in blocks (`SegmentedGroup`, `DragBar`, `ToggleChip`, `Diagnostics`, `Actions`) are the
design's own generic vocabulary. Climate, AV, and Accent all compose from the same five, driven by
config. Adding a control later is a config edit, not a component.

### 5.2 The isometric plane

Straight from the design, all geometry from `config/rooms.json`:

- 470×980 coordinate space, `perspective(1600px) rotateX(55deg) rotateZ(-38deg) scale(.8)`.
- Two nested wrappers so idle sway (`rotate ±1.1deg`, `translateY ±4px`, 16s alternate) composes
  with selection transform without fighting it.
- On room select: `rotateZ = -38 + (490 - cy)*0.012 + (cx - 235)*0.02`, post-scale translate
  `((235-cx)*0.62, (490-cy)*0.52)`, `transform 1.1s cubic-bezier(.22,.8,.24,1)`.
- Occupancy glow: radial amber, `opacity = min(.25 + lightsOn*.13, .8)`.
- Fixture dots: 10px, on = `#ffb267` or the device's color with a `0 0 16px 5px` halo at 45% alpha.
- AC airflow: four S-curved SVG streamlines, `stroke-dashoffset` flow, masked to fade toward the
  room. Animate only while climate power is on.
- Phone: same plane at `scale(.47)`, same motion.

Fixture positions are the design's guesses and are known to be wrong. Because they are data, a later
repositioning pass touches one file.

### 5.3 Device rows and gestures

Pointer events, `touch-action: none`, `setPointerCapture`. Movement >6px enters drag; release
without movement toggles. Drag maps ≈0.55%/px. The row background fills left→right with an amber
gradient (device-color-tinted for color lights); the plan's fixture dot tracks live.

Wire behaviour differs by `dragCommit` (§3.4). The visual is identical either way.

### 5.4 Accent

Panel row, exactly as designed: no on/off tap on the row body's *left* side; scene pills
(Ceiling · Deer · Mirror Ball) on the right. Tapping a pill turns it on with that preset. Tapping
the row body turns it off. Kind tag reads `preset · <name>` when on, `pick a scene to turn on` when off.

Behind `show controls ›`, the drill-in tells the truth:

- **ADJ fixture** segmented group: Ceiling, Webcam Back.
- **SPOT fixture** segmented group: Deer, End Table, Coffee Table, Mirror Ball.
- Brightness drag bar per fixture.
- **DMX scenes**: Wolf, Mirror Ball, DMX Manual (demoted from the global scene bar, per decision 3).
- Diagnostics: DMX server reachability, last command. *(DMX publishes no state — say so.)*

The panel row's single picker is a curated view over the two fixtures. Selecting a `spot` preset
while an `adj` preset is lit is legal and both show; the picker simply reflects whichever was
last chosen from its own list.

### 5.5 Placement of the homeless devices

- **Shades** → Living Room device row with a 0–100% position drag bar. `somfyBridge.js:78` accepts a
  numeric percentage: `POST /api/DEVICES/shades/50` → `target=50`. State arrives on the existing
  `position` field. `dragCommit: "release"`.
- **Theater Projector** → AV cluster, alongside the receiver. Momentary power toggle. It has
  `power_commands` (`power_query`, `power_on_delay`), so it can report real power state.
- **Door** and **Find My iPhone** → persistent utility rail. Momentary triggers, always reachable,
  not room-scoped. Door fires `/api/LOCKS/door/front` (or `apartment`).
- **Plex** and **Jellyfin** (`http://pi.local:8096/web/#/home`) → link-out chips in the Living Room
  group, product logos vendored as inline SVG, visually distinct from stateful device rows (no
  status dot). Not controllable.

### 5.6 Status strip and screen

Strip: green dot + `All systems normal ›` driven by `/api/health`'s `degraded` flag (green → amber
when stale devices exist → red when a bridge is offline). Right side: last-action trace, updated by
every command and every drill-in action response.

Screen (overlays the panel, same drill-in chrome):

- **Bridges** — `apollo`, `hue-sse` from `apollo/bridge/+/status`.
- **Connection** — MQTT WebSocket state, polling-fallback indicator.
- **Devices** — one row per `deviceDetail` entry: name, topic, age, `stale`, `reachable`, last source.
  Stale devices float to the top.
- **Links** — DMX controller, Homebridge (`pi.local:8581`), PM2, Uptime Kuma (`pi.local:3001`),
  log viewer (`/logs/`), and **Legacy dashboard** (`/legacy`).

---

## 6. Design tokens

Verbatim from the handoff, as CSS custom properties in `tokens.css`.

- Background `#141118`; panel `rgba(20,17,26,.7)`; drill-in `#16131c`.
- Text `#eae5ef`; secondary .4–.6α; tertiary .3–.35α; hairlines `rgba(234,229,239,.08–.14)`.
- Accent purple `#a688e8`, active fills `rgba(166,136,232,.14–.18)`.
- Amber `#f2a65e`, text `#f2c79a`, fixture glow `#ffb267`.
- Status green `#7ed9a0`; AC blue `rgba(120,185,255,…)`, border `rgba(140,190,255,.55)`.
- Type: **Outfit** 300/400/500/600, vendored. `ui-monospace` for diagnostic values only.
- Radii: rows 10–11px, buttons 8–10px, pills 999px, sheet 18px top.
- Motion: room turn 1.1s `cubic-bezier(.22,.8,.24,1)`; sway 16s alternate; fill .1s; dot glow .3s;
  wind dash flow 2.1–3s staggered.

Breakpoints: phone < 760px (bottom sheet, `scale(.47)` plane, horizontally scrolling scene pills);
desktop ≥ 760px (plan + 360–370px command panel). The design's `#t3` targets 1180×800 and 390×800.
Tablet falls out of the desktop layout with a narrower panel.

---

## 7. Rollout

**Continuous deployment, not a staged cutover.** The new dashboard takes `/` from its first
deployable increment and gets refined in place, deploying live as it goes. The old AngularJS UI moves
to `/legacy` up front and stays reachable as the escape hatch for the whole transition — that's the
"way to get back to the old dashboard" until the new one is trusted. By the end it is fully replaced
and `/legacy` is deleted; it isn't needed anymore.

This document is a **working guide, not a spec to maintain** — it exists to make the increments
coherent, and it's disposable once the dashboard is built. No `/v2` dual-track; no formal cutover gate.

The increments below are a build order, each independently deployable, not a gated plan:

> **Config symlink reality (discovered during increment 0):** `config/lights.json`, `config/devices.json`,
> and `config/triggers.json` are **symlinks into the sibling `apollo-home-control-private` repo**. So the
> `room` field (and any future device-config edit) lands in the *private* repo, not this one — it has its
> own git history and must be committed/deployed alongside. `config/rooms.json` is a new real file in this
> repo (not symlinked). Editing tools can't write through the symlink; edit the resolved target in
> `../apollo-home-control-private/config/`. A running Apollo also auto-regenerates `triggers.json` from
> `alexaTriggers.js` on config change.

| # | Contents | State after deploy |
|---|---|---|
| **0 ✅ done** | `config/rooms.json` + `.example`, `room` field on lights/devices (in the private repo — see note above), `GET /list/rooms`, `stateTopic` on all `/list/*` entries (lights/devices via `topicFor`; scenes→`apollo/home/scene/<id>/state`; macros→`apollo/home/macro/<id>/state`; deviceScenes none). **Two backend bug-fixes folded in:** seeded the `mqttTopics` merge cache from retained state at boot via `seedFromRetained()` piggybacking healthMonitor's subscription (§4.4); normalised `/api/health` units — per-device `lastSeen`→`lastSeenMs`, added top-level `nowMs`, MQTT summary `timestamp` still seconds (§4.7). Added `/legacy` route serving the in-place old UI (no physical file move — deferred to cleanup; `/` still serves old until increment 1). | Old dashboard reachable at `/legacy`; `/` still serves it; new backend contract live |
| **1 ✅ done** | Vite + Preact scaffold in `web/` (isolated `web/package.json`; deps preact, mqtt, @preact/signals) → builds to `public/app/`, base `/v2/`. Build step added to `update-pi.sh` (builds on Mac, `web/` excluded from rsync, `public/app/` deployed). Outfit vendored offline as woff2 300/400/500/600. `tokens.css` with the full design token set. `/v2` static + SPA-fallback route. State layer under `web/src/state/`: `mqtt.js` (ws://host:9001, subscribes state/health/bridge/scene/macro), `bootstrap.js` (fetch `/api/health` + six `/list/*`, then connect; 3s→polling fallback every 5s), `store.js` (`@preact/signals`, devices keyed by **stateTopic**), `optimistic.js` (pending+4s revert; `dmxFixture`/`wled` authoritative, no revert; ±3 tolerance reconcile), `api.js`. `main.jsx` shows live `connection · N devices`. **Mounted at `/v2`, not `/`** — the empty scaffold must not replace the daily-driver `/`; the swap to `/` happens at increment 5 once device control exists. | New app at `/v2` — live-verified against the real broker (`live · 27 devices`, 0 console errors); `/` + `/legacy` still serve the old UI |
| **2 ✅ done** | Isometric plane (`plan/`: Plane/Room/Furniture/Fixture) with rooms, furniture, fixtures, occupancy glow, 16s sway + 1.1s selection pan/tilt. Room command panel (`panel/`: RoomPanel/DeviceRow/ShadeRow + `useDragGesture`) with tap-toggle, hold+drag level (6px dead zone, ~0.55%/px, per-device `commitMode` release/live), 50% quick-set, switch vs dim rows, live fill bars. Status strip (`status/`) with health dot + last-action trace. Shared contracts (Opus-owned): `state/ui.js` (selectedRoom, lastAction), `state/commands.js` (deviceView + dispatch), `module` tag added in bootstrap. App layout + responsive shell in `main.jsx`/`app.css`. **Live-verified** against the real broker: plane renders centered, room-select pans + swaps panel, `POST /api/LIGHTS/officeDesk/off → 200` with optimistic + trace. Two integration CSS fixes during review: `.app` height:100dvh + overflow:hidden (was stretching the page to the 980px plane box) and plane centering. | Usable device control at `/v2`; DMX fixtures still render as raw dim rows (Accent picker consolidates them in increment 3) |
| **3 ✅ done** | Hue color backend (HSV via GroupLightState hue/sat — group states lack `.rgb`; `/api/LIGHTS/<id>/COLOR/<hex>`, publishes `{power,color}`, SSE xy→hex readback; `isColor` on giantP/bedroomColor) + color-kind rows with swatch drill-in. Accent picker (6 DMX fixtures → one row: Ceiling/Deer/Mirror Ball pills) + Accent drill-in (adj/spot fixture groups + Wolf/Mirror Ball/DMX Manual scenes; reusable DrillInShell/SegmentedGroup for increment 4). Scene shadow-state module `sceneShadow.js` (retained scene/macro active + fingerprint learning w/ settle debounce + drift detection; 15 tests). Tiered scene bar (Hangout/All Lights scene pills + ▸Bedtime/▸Studio/▸Ray's Music macro buttons + ··· More menu w/ Away/Movie Mode), room scene bar (Living Room/Office). Routing (Opus): handler.js passes color param + macro hook; lighting.js COLOR branch + scene hook; commands.js color/scene/macro dispatch. **Bug fixed:** mqttOrphanCleanup was pruning the new `apollo/home/{scene,macro,spotify}/*/state` topics as orphans (would wipe scene shadow on restart) — added a reserved-namespace guard + regression test. Backend-verified live (color→Hue group, scene/macro POSTs). | Parity with old dashboard, plus color, at `/v2` |
| **4 ✅ mostly** | Climate shadow-state module `climateShadow.js` (assumed power/mode/setpoint/fan; absolute→relative IR stepping w/ 600ms spacing; manual override w/o IR; retained `apollo/home/itach/livingRoomAC/state`; 24 tests) + cluster (setpoint stepper, COOL/ECO, "assumed" caption) + drill-in with override form. Anthem state publishing (tcpServers.js queries Z1VOL/Z1INP/Z1MUT, parses, publishes volume/input/mute) + AV cluster (power, deviceScene inputs, dB-native volume bar, mute) + AV drill-in (raw inputs + real diagnostics from entry/health). Projector row. Now-playing card (album art, play/pause via new `spotifyResume`, equalizer). Utility rail (Door → LOCKS/door/front/unlock, Find My). Routing (Opus): handler.js AC-shadow verbs (`isAC` via `alexa.isAC`) + spotify play/pause; commands.js av/climate/spotify/utility dispatch. Backend-verified live (climate setpoint/mode/override 200s; AV cluster renders). **Deferred:** AC airflow animation on the plane (decorative), Plex/Jellyfin chips (increment 3/6 polish), `SPOTIFY_NOW_PLAYING=1` env flag (Ray flips when ready — card shows "Nothing playing" until then). | `#t3` control surface, minus decorative airflow |
| **5 ✅ done** | System status screen (`status/StatusScreen.jsx`, opened from the strip): CONNECTION, BRIDGES, DEVICES (sorted stale/unreachable-first, "N of M reporting normally", monospace topic/age), and admin LINKS (Homebridge, DMX, Uptime Kuma, PM2, Logs, `/legacy`). **Deferrals cleared:** AC airflow on the plane (`plan/AcVent.jsx`+`Airflow.jsx` — vent on the dining wall, 4 animated streamlines when the AC shadow power is ON); Plex/Jellyfin link chips in the Living Room group (`panel/LinkChip.jsx`, inline-SVG logos, correct URLs). **The swap:** Vite `base` → `/`; webServer serves `public/app` at `/` (old AngularJS UI now only at `/legacy`, still-served assets fall through; `/v2` kept as an alias). Live-verified: `/`=new, `/legacy`=old, status screen opens, chips + climate render. Phone layout polished (two-row header with a scrollable scene row + rounded bottom-sheet panel) and Spotify now-playing enabled. **Deployed live to the Pi** (2026-07-09): new dashboard at `pi.local/`, old at `/legacy`, Apollo online, MQTT + Insteon + now-playing all up. | Feature-complete at `/`, live on the Pi; old UI at `/legacy` |
| **6** | Delete `public/legacy/` and the old stack: `public/js/{apollo.js,angular*,materialize*,jquery*,mqttDashboard.js}`, `public/css/materialize*`, the Material/apollo icon fonts. | Legacy gone; this doc no longer needed |

Increment 0 and the increment 3/4 backend slices are the parts that touch device drivers; they carry
the real risk and should each land as their own PR with `APOLLO_DRY_RUN` smoke tests. Because `/` goes
live early, keep each deploy shippable — a broken increment is one `/legacy` click away from recovery,
but shouldn't land broken.

---

## 8. Testing

- Extend the existing smoke tests: `/list/rooms` returns valid JSON5-parsed rooms; every `room` id
  on a device resolves to a room; every `fixtures` key resolves to a device id; `stateTopic` on each
  `/list/*` entry equals `mqttTopics.topicFor(entry,'state')`.
- Unit tests for the shadow-state reducers: absolute→relative setpoint stepping, fan ordinal
  stepping, manual override, retained rehydration after restart.
- Unit tests for scene shadow: `on`/`off` transitions, collision resolution (macro wins), retained survival.
- Optimistic store: pending → confirmed, pending → timeout → revert, "never publishes state"
  device class (DMX, WLED).
- Live-device tests stay behind `--live`, per existing convention.

---

## 9. Open items

**Resolved by live investigation 2026-07-08** (moved out of "open"):
- ~~Anthem volume scale~~ → integer negative dB, single-connection multi-query, input map confirmed (§4.5).
- ~~`spotifySwitchPlay` semantics~~ → it transfers, not resumes; the now-playing card needs a new
  lightweight `spotifyResume()` (§4.6).

**Tracked in the backlog** (GitHub issues, per CLAUDE.md):
- **Scene-fingerprint blind spot: DMX/WLED publish no state** — scenes touching those fixtures
  reconcile only on their Insteon/Hue members. Closing this means making those drivers publish state
  (or Apollo synthesising optimistic state for them). Issue filed.
- **Scene-fingerprint blind spot: color** — closes when §4.3 Hue color state lands; folded into the
  Stage 12 color issue.

**Still genuinely open:**
- **Fixture positions** — the design's are guesses; a repositioning pass against the real apartment
  is deferred, and cheap by construction (all geometry is data in `rooms.json`).
- **Scene divergence copy** — the fingerprint reconciles real drift, but a scene with a partial
  fingerprint (DMX members) can't be fully certain; UI copy must not overclaim for those.
- **Plex integration** — chip only for now; a richer integration is future work.
- **Alexa color** — `color` will ride along in the shadow mirror; wiring the skill to it is Stage 12 proper.
