# MQTT Implementation — Detailed Engineering Plan

Companion to [mqtt-implementation-plan.md](mqtt-implementation-plan.md), which owns the
architecture, topic conventions, payload schema, and stage definitions. This document goes
one level down: concrete module designs, exact integration points in the current codebase,
config schema changes, and per-stage test and deploy steps. Where the two documents
disagree, the strategy doc wins on *what*; this doc wins on *how*.

Issue mapping: Stage numbers here match the strategy doc and the
[GitHub milestones](https://github.com/raypp2/Apollo-Home-Control/milestones).
Relevant issues are cited per stage.

---

## Recommended build order

The strategy doc allows Stages 2–6 in any order after Stage 1. Recommended sequence,
optimizing for early feedback and risk isolation:

```
Stage 0  Pre-work: bug fixes + dry-run mode          (#28, #29, #31, #32, #33)
Stage 1  Mosquitto + mqttClient + topic helpers      (#4, #5, #6)
Stage 2  Native MQTT devices: Shelly → WLED → Somfy  (#7, #8, #9; DMX #10 when firmware ready)
Stage 3  Insteon state publishing                    (#11)
Stage 8  Health monitor (early — it hardens 2–4)     (#20)
Stage 4  Hue SSE                                     (#12)
Stage 9  Dashboard WebSocket + Spotify now-playing   (#21, #22)
Stage 5  iTach/TCP persistent connections            (#13)
Stage 6  Homebridge mqttthing                        (#14)
Stage 7  IoT Core state bridge + ReportState/ChangeReport  (#15–#19)
Stage 10 SQS → shadow-delta commands                 (#23)
Stage 12 Color control                               (#26)
Stage 11 Dashboard redesign (needs its own sub-plan) (#24, #25)
Stage 13 Homebridge 2.0 + Matter (when ecosystem matures)  (#27)
```

Rationale for the two deviations from numeric order:

- **Stage 8 (health monitor) moves up.** It is read-only, small, and immediately validates
  Stages 2–3: a device whose MQTT config is wrong shows up as `stale` instead of silently
  missing. Staleness thresholds can be tuned per-ecosystem as each stage lands.
- **Stage 5 (iTach refactor) moves after Stage 9.** It is the riskiest local change (it
  touches the projector/receiver path used daily) and nothing else depends on it. Do it
  once the MQTT plumbing and dashboard are proven, so its status topics have a consumer
  on day one.

---

## Stage 0 — Pre-work (bug fixes that MQTT work depends on)

All filed during the 2026-07 code review. Doing these first avoids building MQTT on
known-broken foundations, and the dry-run flag is a prerequisite for testing MQTT routing
without actuating hardware.

1. **[#33](https://github.com/raypp2/Apollo-Home-Control/issues/33) — `APOLLO_DRY_RUN` mode.**
   Gate every outbound transport at the driver boundary:
   `iTachControllers.js` (3 send functions), `tcpServers.js`, `somfyBridge.js`,
   `lightingShelly.js`, `lightingWled.js`, `lightingDmx.js`, `lightingInsteon.js`
   (`insteon_send_command`), `spotify.js`, `findMy.js`. Pattern:

   ```js
   const DRY_RUN = process.env.APOLLO_DRY_RUN === '1';
   // at the top of each send function:
   if (DRY_RUN) { console.log("%d - DRY RUN, would send: %s", debug_id, cmd); return; }
   ```

   In `index.js`, skip `sqsListener.startListener()` and
   `insteonListener.startListener()` when dry-run. `test/smoke.js` sets
   `APOLLO_DRY_RUN=1` in the spawn env by default, with `--live` restoring today's
   behavior. MQTT publishes stay **enabled** in dry-run — that is the point: routing
   logic becomes observable via `mosquitto_sub` without touching hardware.

2. **[#29](https://github.com/raypp2/Apollo-Home-Control/issues/29) — end every HTTP response.**
   The dashboard keeps calling `/api/*` through Stage 11; hung responses will otherwise
   pollute the new dashboard's fetch error handling.

3. **[#28](https://github.com/raypp2/Apollo-Home-Control/issues/28) — SQS listener minimal fixes.**
   Only the poison-message guard and error backoff. Skip the dedupe rewrite — SQS is
   deleted in Stage 10; don't invest beyond safety.

4. **[#31](https://github.com/raypp2/Apollo-Home-Control/issues/31) / [#32](https://github.com/raypp2/Apollo-Home-Control/issues/32)**
   land naturally when Stage 3 touches `lightingInsteonListener.js` and Stage 10 touches
   `handler.js`; fix earlier if convenient.

---

## Cross-cutting foundations

### New modules and load order

Two new modules in Stage 1, one in Stage 8, one in Stage 10:

| Module | Depends on config? | Load order note |
|---|---|---|
| `src/mqttClient.js` | No — env vars only | Safe to require anywhere, no `require('../index')` |
| `src/mqttTopics.js` | Yes — needs `lights`/`devices` | Uses the standard `require('../index')` pattern; must load after `index.js` exports (same rule as every existing module) |
| `src/healthMonitor.js` | Yes | Same |
| `src/mqttCommandListener.js` | Yes (+ handler) | Same |

`index.js` startup order becomes:

```js
module.exports = { devices, ..., logging };          // unchanged, exports first
const mqttClient = require('./src/mqttClient');
mqttClient.connect();                                 // 1. broker connection first
const { handleRequest } = require('./src/handler.js');// 2. existing modules (drivers
alexa.buildTriggers();                                //    require mqttClient freely —
webServer.startServer();                              //    no circularity, it never
sqsListener.startListener();                          //    requires ../index)
insteonListener.startListener(handleRequest);
require('./src/healthMonitor').start();               // 3. last — observes everything
```

`connect()` must be non-blocking (mqtt.js queues publishes while offline); Apollo must
start and serve HTTP even if Mosquitto is down.

### Config schema changes (issue #6)

Two new optional fields on every entry in `lights.json` and `devices.json`:

```json5
{
  "id": "livingRoomBookshelf",        // unchanged — API identity, Alexa endpointId
  "location": "living-room",          // NEW: topic level 2. Default: "home"
  "mqttName": "bookshelf",            // NEW: topic level 4. Default: id
  ...
}
```

`mqttName` exists because current IDs bake the location in (`kitchen`, `officeDesk`,
`livingRoomBookshelf`) which violates the topic convention's naming rule
(`apollo/living-room/insteon/livingRoomBookshelf/state` repeats the room). Renaming `id`
itself is not an option — it is the Alexa endpointId and the public API path. So:
**`id` stays the system-wide identity; `mqttName` is only cosmetic topic naming.**
Devices without `mqttName` fall back to `id` — the system works before any config is
edited, and rooms can be migrated one at a time.

Ecosystem (topic level 3) is derived, not configured:

| Config `type` | Topic ecosystem |
|---|---|
| `insteon` | `insteon` |
| `hue-group` | `hue` |
| `dmxFixture` | `dmx` |
| `shelly` | `shelly` |
| `wled` | `wled` |
| `iTach_serial` / `iTach_ir` / `iTach_CC` | `itach` |
| `ip_control` | `ip` |
| `Somfy-Bridge` | `somfy` |
| `spotify` | `spotify` |
| `findMyIphone` | *(none — no state topic)* |

### `src/mqttClient.js` design (Stage 1)

Thin wrapper over the `mqtt` package (v5.x). Entire public surface:

```js
connect()                          // idempotent; called once from index.js
publish(topic, payload, opts)      // payload: object → JSON.stringify, string → as-is
                                   // opts default: { qos: 1, retain: false }
subscribe(topicFilter, handler)    // handler(topic, parsedPayload, raw)
                                   // registry survives reconnect (resubscribe on 'connect')
isConnected()                      // for health + dashboard fallback logic
```

Implementation notes:

- `mqtt.connect(process.env.MQTT_BROKER_URL || 'mqtt://localhost:1883', { will: {...},
  reconnectPeriod: 5000, queueQoSZero: false })`. mqtt.js handles reconnect natively —
  do not hand-roll backoff.
- LWT: topic `apollo/bridge/apollo/status`, payload `offline`, retained, QoS 1. On every
  `connect` event, publish retained `online` to the same topic and replay the
  subscription registry.
- Wildcard dispatch: store `{filter, handler}` pairs; match incoming topics with a
  ~15-line `topicMatches(filter, topic)` helper (split on `/`, honor `+` and `#`) rather
  than adding a dependency.
- JSON parse failures on inbound messages: log with topic and first 100 bytes, drop the
  message, never throw (the global uncaughtException handler must not become the MQTT
  error path).
- Log connection state transitions only (connect / offline / reconnect), not every retry —
  a down broker must not flood `apollo.log`.

### `src/mqttTopics.js` design (Stage 1)

The only place topic strings and payloads are constructed. Drivers never concatenate
topic strings.

```js
topicFor(entry, attribute)      // entry = lights.json/devices.json object
                                //   → "apollo/<location>/<ecosystem>/<mqttName>/<attribute>"
publishState(entry, state, source)
                                // merges state into the last-known state for that device,
                                // stamps { reachable: true, timestamp, source },
                                // publishes retained QoS 1 to topicFor(entry, 'state')
publishUnreachable(entry)       // republishes last state with reachable:false (retained)
lastState(entry)                // in-memory cache of last published state per device
findByTopic(topic)              // reverse lookup: set/state topic → config entry
```

`publishState` merging matters: a brightness-only event must not erase the power field.
The in-memory cache doubles as the state source for `/api/health` (Stage 8) and the
optimistic-verification comparisons (Stage 3).

### Command tracing

Preserve the `operation_num` logging convention for MQTT-originated events. Inbound
`set` messages and shadow deltas (Stage 10) route through `handleRequest`, which already
assigns numbers. State publishes triggered by device events (SSE, native MQTT, Insteon
listener) log with the existing `X -` prefix convention used by the Insteon listener.

---

## Stage 1 — Mosquitto + client plumbing (issues #4, #5)

**Pi (manual or via SSH, ~30 min):**

```bash
sudo apt install mosquitto mosquitto-clients
sudo tee /etc/mosquitto/conf.d/apollo.conf <<'EOF'
listener 1883
listener 9001
protocol websockets
allow_anonymous true      # VLAN isolation is the security boundary (per strategy doc)
persistence true          # retained messages survive broker restart
EOF
sudo systemctl enable --now mosquitto
```

**Apollo:** add `mqtt` to package.json; create `mqttClient.js` + `mqttTopics.js` per the
designs above; wire into `index.js`; add `MQTT_BROKER_URL` to `.env` and `sample.env`.
Deploy needs `--install` (package-lock changes).

**Monitoring:** Uptime Kuma TCP check on `<pi>:1883`.

**Tests** (`test/mqttClient.test.js`): topic matcher unit tests (exhaustive `+`/`#`
cases); payload construction (required fields present, brightness omitted when absent);
integration round-trip + retained-message + LWT tests that skip gracefully when no broker
listens on localhost:1883. Extend smoke test: after startup, `apollo/bridge/apollo/status`
must be retained `online` (checked via a second mqtt client connection, dry-run mode).

**Verify on Pi:** `mosquitto_sub -t 'apollo/#' -v` shows the status topic; `pm2 stop
Apollo` → LWT `offline` arrives; restart → `online`.

---

## Stage 2 — Native MQTT devices (issues #7, #8, #9, #10)

One correction to the strategy doc's assumption ("no translation layer needed"): the
device topic **prefix** can follow the Apollo convention, but each device publishes its
own native payload schema on its own subtopics. Consumers must not need to understand
per-vendor payloads, so each driver gains a small **normalizer**: subscribe to the native
subtopics, republish canonical JSON on `<prefix>/state`. This keeps the "canonical topics
only" promise at the payload level, not just the topic level. Commands stay on HTTP in
this stage (known-working path); switching commands to MQTT is optional per-device later.

Per ecosystem — device UI config, native topics consumed, canonical output:

### Shelly (Gen2+, issue #7)
- Device UI: MQTT server `<pi>:1883`, custom prefix `apollo/<location>/shelly/<mqttName>`.
- Native in: `<prefix>/status/switch:0` — JSON `{"output": true, "apower": ...}`;
  LWT on `<prefix>/online` (`true`/`false`).
- Normalize: `output` → `power`; `online:false` → `publishUnreachable`.
- `lightingShelly.js` also publishes optimistic state (`source: "command"`) after its
  existing HTTP send; the native event confirms or corrects it seconds later.

### WLED (issue #8)
- Device UI: Sync → MQTT, device topic `apollo/<location>/wled/<mqttName>`.
- Native in: `<topic>/g` (0–255 master brightness, `0` = off) and `<topic>/v` (XML API
  state). Use `/g` only: `power = g > 0 ? ON : OFF`, `brightness = round(g/255*100)`.
- LWT: WLED publishes `<topic>/status` = `online`/`offline` — map to reachable.

### ESPSomfy-RTS (issue #9)
- Device UI: MQTT root topic `apollo/<location>/somfy`.
- Native in: `<root>/shades/<shadeId>/position` (0–100), `/direction`, plus bridge LWT
  under `<root>/status`.
- Normalize: `position` → canonical `position` field; shadeId → config entry via the
  existing `address`/shade-id mapping in `devices.json`.
- Optional in this stage: switch `send_somfy_command` from HTTP GET to MQTT publish
  (`<root>/shades/<id>/target/set`). Recommended — the ESPSomfy bridge blocks ICMP and
  its HTTP occasionally needs retries; MQTT gets QoS 1 for free. Keep the HTTP function
  as fallback behind `SOMFY_VIA_MQTT=true`.

### DMX bridge (issue #10)
- Blocked on firmware work in the separate DMX bridge repo (publish fixture state,
  subscribe to commands). Define the contract now — bridge publishes canonical payloads
  directly on `apollo/<location>/dmx/<fixture>/state` (it is our firmware; it can speak
  the convention natively, unlike the vendors above). Apollo-side change is then just a
  subscription in `lightingDmx.js`.

**Tests:** normalizer unit tests per ecosystem (native payload fixture → expected
canonical JSON — pure functions, no broker). Manual per device: physical toggle →
canonical state on `mosquitto_sub` within 2s; power-cycle device → `reachable:false`
then `true`.

**Deploy:** one device type at a time, one physical device first. Nothing breaks if a
device's MQTT is misconfigured — HTTP command path is untouched.

---

## Stage 3 — Insteon state publishing (issue #11)

All changes in `lightingInsteonListener.js` and `lightingInsteon.js`.

1. **Event publishing:** in the existing `hub.on('command')` handler and in
   `insteon_status_listener`'s `turnOn`/`turnOff` callbacks, look up the light by
   address and `publishState(light, {power, brightness}, 'event')`.
2. **Re-enable polling — staggered, not the disabled bulk version.** The commented-out
   `insteon_setup_devices()` polls every device simultaneously; the 2245 hub has a small
   command buffer and this is exactly the failure mode the old code comments warn about.
   Instead: round-robin one device every 5s (12 insteon lights ≈ full sweep per minute),
   pausing the sweep for 10s after any outbound command (share a `lastCommandAt`
   timestamp with `insteon_send_command`).
3. **Optimistic state + verification:** `insteon_device_command` publishes
   `source:"command"` state immediately, then schedules a single `hub.light(addr).level()`
   check 5s later; on mismatch, publish the polled truth (`source:"poll"`).
4. **Fix [#31](https://github.com/raypp2/Apollo-Home-Control/issues/31) here** (same
   file): replace the never-expiring `last_command` dedupe with a 3-second window.
5. `insteon_button_blink`'s undefined-variable bug: fix or delete while in the file
   (currently dead — its only call site is commented out).

**Risk note:** `home-controller` is unmaintained and its hub connection has been the
historic crash source (closed issue #2). Keep the polling loop wrapped so a hub error
disables polling for 60s rather than tight-looping.

**Tests:** unit-test the address→light lookup and payload mapping. Manual: API command →
optimistic state then confirming poll on `mosquitto_sub`; physical KeypadLinc press →
event-sourced state within 1s; pull a lamp module mid-sweep → poll marks it unreachable.

---

## Stage 8 — Health monitor (issue #20) — built early, see ordering rationale

`src/healthMonitor.js`, read-only consumer:

- Subscribes to `apollo/+/+/+/state` and `apollo/+/+/+/status`; keeps
  `{ lastSeen, lastState }` per device (seeded from retained messages at startup — free
  persistence).
- Staleness thresholds per ecosystem, constants in the module (move to config only if
  they churn): shelly/wled 90s (they heartbeat), insteon 180s (poll sweep ≈ 60s),
  hue 60s (SSE, from Stage 4), somfy 300s, itach/ip on connection status not time
  (Stage 5). Ecosystems not yet publishing are absent from the map — no false alarms
  during rollout.
- On breach: log warning, publish retained `apollo/health/<location>/<mqttName>/status`
  = `stale`, and call `publishUnreachable(entry)` so downstream consumers (dashboard,
  IoT Core shadows later) see `reachable:false` rather than confidently-stale state.
- Recovery: any fresh state message clears stale status.
- `GET /api/health` on the existing express app: JSON summary (per-device lastSeen/state,
  broker connected, counts). Uptime Kuma polls it with a keyword check on `"degraded":false`.
- Every 5 min, publish `apollo/health/summary` (retained).

**Tests:** unit-test threshold logic with injected clock (no timers in tests). Manual:
unplug a Shelly, watch stale flow end-to-end into Uptime Kuma.

---

## Stage 4 — Hue SSE (issue #12)

New `src/lightingPhilipsHueListener.js`, modeled on the Insteon listener:

- Raw SSE via Node 20 native `fetch` to `https://<PHILIPS_HUE_IP>/eventstream/clip/v2`,
  headers `hue-application-key: <PHILIPS_HUE_USERNAME>`, `Accept: text/event-stream`,
  with a custom `Agent`/dispatcher accepting the bridge's self-signed cert. A ~40-line
  SSE line-parser avoids both a new dependency and the abandoned-package risk
  (`philips-hue-push-client` is tiny and unmaintained; parsing SSE is simpler than
  auditing it).
- **UUID mapping:** at startup, `GET /clip/v2/resource/grouped_light` and `/light`; build
  `{v2-uuid → v1 id}` from each resource's `id_v1` field (`/groups/3` → `3`), then map
  v1 ids to `lights.json` entries via the existing `address` field. Log any config
  entry with no match.
- On `grouped_light` / `light` events: map `on.on` → power, `dimming.brightness` →
  brightness (also stash color for Stage 12), `publishState(entry, ..., 'event')`, and
  update the in-memory `lights` array (keeps `/list/lights` accurate for the dashboard).
- Reconnect: on stream error/close, retry with capped exponential backoff (5s → 60s).
  While disconnected, poll v1 `GET /api/<key>/groups` every 10s as the fallback, and
  publish hue ecosystem status `stale` so the health monitor reflects degraded mode.
- `lightingPhilipsHue.js`: publish optimistic `command`-source state after
  `setGroupState`; SSE confirms within ~1s (self-correcting per the strategy doc, no
  verification poll needed). Also fix the latent `initializeApi()` race here (concurrent
  first calls create two connections — memoize the *promise*, not the result).

**Tests:** unit-test the SSE parser (chunk fixtures, split-across-chunks case) and the
UUID→config mapping. Manual: Hue app change → MQTT state <2s; restart Hue bridge →
fallback polling engages, SSE resumes.

---

## Stage 9 — Dashboard WebSocket + Spotify (issues #21, #22)

Per the strategy doc, with these specifics:

- Vendor `mqtt.min.js` into `public/js/` (no CDN — dashboard must work with internet down;
  note `index.html` currently loads AngularJS from Google's CDN, worth vendoring at the
  same time for the same reason).
- `public/js/mqttDashboard.js`: connect `ws://<location.hostname>:9001`, subscribe
  `apollo/+/+/+/state` and `apollo/health/#`. Match messages to scope entries by
  `mqttName`/`id` (serve the mapping to the browser by including `location`/`mqttName`
  in the `/list/*` responses — they already serialize the full config objects, so this
  is free once issue #6 fields exist). Update `checked`/`status` fields, `$scope.$apply()`.
- Keep initial `$http.get('/list/...')`; delete the three `$interval(fetchList, 5000, 10)`
  pollers only after MQTT connect succeeds — on MQTT disconnect, restart polling
  (connection indicator red).
- Spotify: 10s poll of `getMyCurrentPlaybackState()` → retained
  `apollo/home/spotify/player/state` (track, artist, album art URL, is_playing, device).
  Skip polling when the token refresh fails; publish `reachable:false` equivalent so the
  card greys out. Lives in `spotify.js` behind `SPOTIFY_NOW_PLAYING=true` (it costs an
  API call every 10s around the clock; keep it opt-in until Stage 11 makes real use of it).

---

## Stage 5 — iTach + TCP persistent connections (issue #13)

The largest pure refactor. Shared connection layer, new `src/deviceConnection.js`:

```js
class DeviceConnection {
  constructor({ host, port, name })   // one instance per host:port, kept in a module map
  send(cmd, {expectResponse}) → Promise<string|null>
  onStatusChange(cb)                  // 'online' | 'offline' — feeds status topics
}
```

- Lazy connect on first `send`; serialized queue (one in-flight command; iTach allows a
  single TCP client per port — this also removes today's race where two rapid commands
  open colliding sockets).
- Inter-command spacing configurable per device (replaces the hardcoded 1s `setTimeout`
  chains); response framing by `\r` terminator with 3s timeout.
- Reconnect with backoff; commands queued during reconnect, flushed on connect, dropped
  with a logged error after 30s (a stale "power on" firing minutes later is worse than
  failing loudly).
- Publish `apollo/<location>/itach/<mqttName>/status` on status change.

`iTachControllers.js` collapses its three near-identical functions into thin wrappers
(serial: raw write; IR/CC: append `\r\n`, parse `completeir`/`getstate` responses).
`tcpServers.js` keeps its power-check state machine but sends through `DeviceConnection`;
serial/PJLink responses (`%1POWR=1`) become state publishes for the projector. Periodic
power polling via existing `power_commands` config (60s) → `publishState(..., 'poll')`.

**Rollback flag** (per strategy doc): `ITACH_PERSISTENT_CONNECTIONS=false` routes
wrappers to the old per-command code path, which stays in-tree until one stable month
passes.

**Tests:** unit-test the queue/framing/timeout logic against a local `net.createServer`
fixture (fake iTach — this one *can* be tested honestly without hardware). Manual: rapid
double command (the old race); mid-command network unplug; projector power query.

---

## Stages 6, 7, 10, 12 — summarized (AWS/Homebridge-heavy)

The strategy doc's coverage of these is already implementation-grade (bridge config,
thing-per-endpoint shadow layout, LWA setup, parallel-run migration). Apollo-side code
deltas only:

- **Stage 6 (#14):** no Apollo code. `homebridge-mqttthing` config maps the door buzzer
  to `apollo/entrance/homebridge/door/{set,state}`; Apollo already routes anything on
  canonical topics.
- **Stage 7 (#15–#19):** Apollo-side is only Mosquitto `bridge.conf` (topic remap
  `apollo/+/+/+/state` → per-thing shadow updates) plus a startup log line for cert
  expiry days. Lambda work happens in the
  [Apollo-Alexa-Skill](https://github.com/raypp2/Apollo-Alexa-Skill) repo. One Apollo
  prerequisite: `alexaTriggers.js` should emit `location`/`mqttName` into
  `triggers.json` so the Lambda can map endpointId → shadow name — add that field in
  Stage 1 while touching config schemas.
- **Stage 10 (#23):** new `src/mqttCommandListener.js` subscribes to bridged shadow
  delta topics, translates desired-state JSON to the existing
  `/MODULE/DEVICE/COMMAND/...` string, calls `handleRequest` (no response object — the
  SQS pattern), then publishes reported state. Runs in parallel with SQS ≥2 weeks with
  per-command source logging; then `sqsListener.js` and the `@aws-sdk/client-sqs`
  dependency are deleted (which also closes the remainder of #28).
- **Stage 12 (#26):** extend the Stage 4 SSE mapper and the WLED/DMX normalizers with
  the `color` payload field; shadow + Lambda changes per strategy doc.

---

## Testing & deploy conventions (all stages)

- `npm test` becomes a runner over `test/*.test.js` (Node built-in `node --test` works on
  Node 20 and keeps the no-framework rule) plus the existing smoke suite in dry-run mode.
- Unit tests never require a broker; integration tests probe localhost:1883 and skip
  with a visible `SKIPPED (no broker)` line. CI-ready but not CI-dependent.
- Every stage deploys via `bash private/update-pi.sh --deploy` (add `--install` only when
  package-lock changed: Stages 1 and 10). After each deploy: `mosquitto_sub -t 'apollo/#' -v`
  spot-check + `pm2 logs Apollo --lines 50` for connection-state lines + Uptime Kuma green.
- Each stage is a PR against `main`, merged only with its tests passing, per the
  strategy doc.

## Effort snapshot

| Stage | New/changed code | Estimate (focused sessions) |
|---|---|---|
| 0 | ~10 files, small edits | 1 |
| 1 | mqttClient + mqttTopics + wiring (~350 LOC + tests) | 1–2 |
| 2 | 3 normalizers + device UI config (~150 LOC) | 1–2 (device-by-device) |
| 3 | Insteon listener/driver edits (~150 LOC) | 1–2 |
| 8 | healthMonitor (~200 LOC) | 1 |
| 4 | Hue SSE listener (~250 LOC) | 2 |
| 9 | dashboard JS + spotify poll (~200 LOC) | 1–2 |
| 5 | deviceConnection + two refactors (~400 LOC) | 2–3 |
| 6 | Homebridge config only | 1 |
| 7 | bridge.conf + AWS + Lambda repo | 2–3 (+ Ray's ~20 min LWA) |
| 10 | commandListener + Lambda + SQS removal | 2 (+ 2-week parallel run) |
| 12 | color fields across 3 drivers + Lambda | 1–2 |
| 11 | sub-plan first (issue #24), then implement | separate plan |
| 13 | blocked on Matter plugin maturity | revisit |
