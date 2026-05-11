# MQTT Implementation Plan — Staged Rollout

## Goal

Add a unified MQTT state and command bus to Apollo so that:
1. Every device ecosystem publishes its current state
2. Apollo can detect when devices stop responding
3. Alexa can query and display accurate device state via ReportState
4. The system self-diagnoses failures instead of waiting for the user to notice

## Architecture

```
          ┌──────────────────────────────────┐
          │        Alexa Smart Home          │
          │  ReportState ◄── IoT Core Shadow │
          │  ChangeReport ──► Event Gateway  │
          │  Directives ──► SQS (current)    │
          └──────────────┬───────────────────┘
                         │
                ┌────────▼────────┐
                │  AWS IoT Core   │
                │ (Device Shadows)│
                └────────▲────────┘
                         │ MQTT bridge
                         │ (Mosquitto → IoT Core)
┌──────────────┐ ┌───────┴─────────┐ ┌──────────────┐
│  Mosquitto   │◄►│     Apollo      │─►│ Uptime Kuma  │
│  (local)     │ │   (index.js)    │ │ (monitoring) │
└──────┬───────┘ └───────┬─────────┘ └──────────────┘
       │                 │
       │ native MQTT   commands via
       │               HTTP/TCP/serial
       │                 │
  ┌────▼─────────┐ ┌─────▼───────────┐
  │ Shelly, WLED │ │ Insteon, Hue,   │
  │ ESPSomfy-RTS │ │ iTach, TCP/IP   │
  │ DMX Bridge   │ │                 │
  └──────────────┘ └─────────────────┘

  ┌──────────────┐
  │  Homebridge  │◄── MQTT (via homebridge-mqttthing)
  │  (HomeKit)   │
  └──────────────┘
```

**Why IoT Core for Alexa:** IoT Core Device Shadows provide the full Alexa integration — both ReportState (Alexa queries device state) and proactive ChangeReports (Echo Shows update in real-time when a physical switch is toggled). Mosquitto's built-in bridge forwards local state topics to IoT Core, which triggers a Lambda to push ChangeReports to the Alexa Event Gateway. Cost is pennies/month at home automation volumes.

**SQS → IoT Core for commands (Stage 10):** SQS currently handles Alexa commands reliably. Once IoT Core is wired up for state (Stage 7), commands can migrate to the shadow "desired state" pattern — collapsing both directions into one system and eliminating SQS entirely.

---

## MQTT Conventions

### Topic Hierarchy

```
apollo/<location>/<ecosystem>/<device_id>/<attribute>
```

**Why location first:** Groups devices by physical space for easier monitoring, dashboard views, and automation rules. Subscribing to `apollo/living-room/#` gives you everything in that room regardless of ecosystem.

| Level | Values | Examples |
|-------|--------|---------|
| `location` | Room or zone from device config | `living-room`, `bedroom`, `kitchen`, `theater`, `office`, `outdoor` |
| `ecosystem` | Protocol/platform | `insteon`, `hue`, `shelly`, `wled`, `somfy`, `dmx`, `itach`, `ip`, `spotify`, `homebridge` |
| `device_id` | Descriptive name for the device | `light`, `dimmer`, `giantP`, `shades`, `projector` |
| `attribute` | State or control channel | `state`, `set`, `status` |

**Device ID naming rule:** The `device_id` should describe the device itself, not repeat the location. Use `light` not `kitchen` for the kitchen light; use `projector` not `theaterProjector` for the theater projector. The location is already in the topic path. If a room has multiple devices of the same type, differentiate them: `light-ceiling`, `light-table`.

**Examples:**
```
apollo/kitchen/insteon/light/state             # Kitchen Insteon dimmer
apollo/living-room/hue/giantP/state            # Living room Hue light
apollo/bedroom/somfy/shades/state              # Bedroom shade position
apollo/theater/itach/projector/status           # iTach connection health
apollo/bridge/apollo/status                    # Apollo bridge online/offline
```

**Canonical topics only:** All consumers (dashboard, health monitor, IoT Core bridge) subscribe exclusively to `apollo/...` topics. Native MQTT devices (Shelly, WLED, ESPSomfy-RTS) are configured to publish directly on Apollo-convention topics via their web UIs — no translation layer needed. For devices that can't be reconfigured (unlikely), Apollo subscribes to the native topic and republishes on the canonical topic.

### Retained Messages

All `state` topics use **retained messages** so that new subscribers (dashboard, health monitor, reconnecting clients) immediately get the last known state. When a device goes offline (LWT or staleness detection), Apollo publishes a retained state update with `"reachable": false` to the device's state topic so new subscribers don't see stale state without context.

### QoS Levels

- **State messages:** QoS 1 (at-least-once). State is idempotent — duplicates are harmless since the latest state always wins.
- **Command messages (`set` topics):** QoS 1. Commands routed through Apollo are deduplicated by the handler (if the device is already in the desired state, the command is a no-op).
- **IoT Core shadow deltas (Stage 10):** Shadow delta mechanism inherently deduplicates — the delta clears when reported state matches desired state, so a replayed delta against an already-converged shadow produces no action.

### State Payload Format

All state messages use JSON:

```json
{
  "power": "ON",
  "brightness": 80,
  "reachable": true,
  "timestamp": 1715300000,
  "source": "event"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `power` | `"ON"` / `"OFF"` | Yes | Power state |
| `brightness` | `0-100` | No | Dimmer level (omit for non-dimmable) |
| `position` | `0-100` | No | Shade position: 0=open, 100=closed |
| `color` | `{"hue":0,"sat":100}` | No | Color (Hue lights, WLED, DMX) |
| `reachable` | `true` / `false` | Yes | Whether the device is reachable. Set to `false` on LWT/staleness. |
| `timestamp` | Unix epoch (seconds) | Yes | When this state was observed |
| `source` | `"command"` / `"event"` / `"poll"` | Yes | How we know this state |

`source` values:
- `command` — Apollo sent a command and assumes the resulting state (optimistic — verified by follow-up poll)
- `event` — device reported a state change (SSE, native MQTT, Insteon event)
- `poll` — periodic device query confirmed this state

### Optimistic State Verification

When Apollo sends a command and publishes state with `source: "command"`, it is assuming the device obeyed. This assumption can be wrong (device offline, RF interference, IR missed). To prevent stale optimistic state from propagating to Alexa and the dashboard:

- After publishing a `command`-source state, schedule a verification poll 3-5 seconds later
- If the poll result disagrees with the optimistic state, publish a correction with `source: "poll"`
- For fire-and-forget protocols (iTach IR), there is no verification possible — document these devices as "unverifiable" in the health monitor
- Ecosystems with event feedback (Hue SSE, native MQTT devices) self-correct via the event stream — no poll needed

### Command Payload Format

Messages on `set` topics:

```json
{
  "power": "ON",
  "brightness": 50
}
```

Omit fields that shouldn't change. Apollo subscribes to `set` topics and routes to the appropriate driver.

### Status Topics

Connection health for bridges and ecosystems:

```
apollo/bridge/apollo/status        → "online" / "offline" (LWT)
apollo/bridge/mosquitto/status     → broker health
apollo/<location>/<ecosystem>/<device>/status → "online" / "offline" / "stale"
```

### Location Mapping

The `location` for each device comes from a new field in `lights.json` and `devices.json` config files. Devices without a location default to `home`. This field is also useful for future dashboard grouping.

```json
{
  "id": "kitchen",
  "title": "Kitchen",
  "location": "kitchen",
  "type": "insteon",
  "address": "469B35"
}
```

### Security

Mosquitto is configured for LAN-only access (no internet-facing ports). MQTT on port 1883 and WebSocket on port 9001 are accessible to any device on the home network. This is an intentional tradeoff: authentication adds complexity and failure modes for a single-user system on a private network.

**Accepted risk:** Any device on the LAN can subscribe to all state topics and publish commands. This is acceptable as long as the network does not include untrusted devices.

**If the threat model changes** (guest WiFi shared with IoT network, adding untrusted cameras, etc.):
- Add Mosquitto username/password authentication (`password_file`)
- Add ACLs to restrict which clients can publish to `set` topics
- Consider TLS for the MQTT and WebSocket listeners

IoT Core side is secured by X.509 certificates (only the Mosquitto bridge can connect) and IAM policies (Lambda permissions are scoped to specific shadows).

---

## Testing Strategy

Each stage adds tests alongside the implementation. Apollo already has smoke tests (`test/smoke.js`) and ESLint; MQTT work extends this foundation.

### Test levels:

**Unit tests (per module):**
- Each new `src/` module gets a corresponding `test/` file (e.g., `test/mqttClient.test.js`)
- Test MQTT message parsing, topic construction, payload formatting, state mapping
- Mock the MQTT client for unit tests — validate that the right topics and payloads are produced without needing a running broker
- Test reconnection logic, error handling, edge cases (malformed messages, missing fields)

**Integration tests (with Mosquitto):**
- Require a running Mosquitto instance (local dev or CI)
- Verify publish/subscribe round-trips: publish a state message, verify subscriber receives it
- Test retained messages: subscribe after publish, verify last state is received
- Test LWT: disconnect client ungracefully, verify offline message arrives
- Test WebSocket connectivity (Stage 9): verify browser-style client can connect on port 9001

**Smoke tests (existing pattern, extended):**
- Extend `test/smoke.js` with MQTT-aware checks as stages are deployed:
  - Stage 1: verify Apollo connects to Mosquitto and publishes bridge status
  - Stage 2+: verify state topics are published when commands are sent via API
  - Stage 9: verify `/list/*` endpoints still work (dashboard fallback path)

**End-to-end Alexa path test (Stage 7):**
- The most critical path spans Apollo → Mosquitto → IoT Core → Lambda → Alexa Event Gateway
- Automate everything up to the Event Gateway: publish a state change locally, verify the IoT Core shadow updates, verify the ChangeReport Lambda fires with the correct payload
- Mock the Alexa Event Gateway call in the Lambda test to verify the ChangeReport format
- The final hop (Event Gateway → Echo Show) is manual — verify visually that the Echo Show updates

**Manual validation (per stage):**
- Each stage includes specific manual test steps (documented in the stage itself)
- These cover physical device interaction that can't be automated (pressing a switch, unplugging a device)

### Conventions:
- Test files live in `test/` alongside existing `smoke.js`
- Use Node's built-in `assert` module (no test framework dependency)
- Tests run via `npm test` — update the test script to run all `test/*.test.js` files
- Integration tests that need Mosquitto are skipped gracefully if the broker isn't available
- Each stage PR should not be merged until its tests pass

---

## Stage 1: Mosquitto Broker + MQTT Client in Apollo

**What:** Install Mosquitto on the Pi, add an MQTT client to Apollo that connects at startup. No device integration yet — just the plumbing.

**Changes:**
- Install Mosquitto on Pi (`apt install mosquitto mosquitto-clients`)
- Configure Mosquitto for local-only access (listener on `localhost:1883` or LAN-only)
- Enable WebSocket listener (`listener 9001`, `protocol websockets`) for browser MQTT clients
- Add `mqtt` npm package to Apollo
- Create `src/mqttClient.js`:
  - Connects to broker on startup
  - Exports `publish(topic, payload, options)` and `subscribe(topic, callback)`
  - Handles reconnection with exponential backoff
  - Publishes `apollo/bridge/apollo/status` = `online` with LWT `offline`
  - Logs connection state changes
- Add `.env` vars: `MQTT_BROKER_URL=mqtt://localhost:1883`
- Wire into `index.js` — connect before starting other modules
- Add Mosquitto to Uptime Kuma monitoring (TCP check on port 1883)

**Test:** Start Apollo, verify Mosquitto receives the bridge status message. Use `mosquitto_sub -t 'apollo/#' -v` to watch. Kill Apollo, verify LWT `offline` message arrives.

**Deployable independently:** Yes. No device behavior changes.

---

## Stage 2: Native MQTT Devices (Shelly, WLED, ESPSomfy-RTS, DMX)

**What:** Enable MQTT on devices that support it natively, subscribe in Apollo, update state.

### Shelly
- Enable MQTT in Shelly web UI, point to Mosquitto broker
- Configure custom topic prefix in Shelly settings to publish directly on Apollo convention topics (e.g., `apollo/kitchen/shelly/light`)
- Shelly Gen2+ devices support custom MQTT topic prefixes natively
- In `src/lightingShelly.js`, subscribe to Apollo-convention topics — no translation needed

### WLED
- Enable MQTT in WLED settings, point to Mosquitto broker
- Configure WLED's "Device Topic" to follow Apollo convention (e.g., `apollo/theater/wled/strips`)
- WLED publishes state and accepts commands on the configured topic
- In `src/lightingWled.js`, subscribe to Apollo-convention topics — no translation needed

### ESPSomfy-RTS
- Enable MQTT in ESPSomfy-RTS Network settings (web UI)
- Set root topic to follow Apollo convention (e.g., `apollo/bedroom/somfy`)
- ESPSomfy publishes shade position, direction, tilt on subtopics and accepts set commands
- Also publishes LWT status (online/offline), firmware, IP address
- In `src/somfyBridge.js`, subscribe to Apollo-convention topics. Can switch commands from HTTP to MQTT.

### DMX Bridge
- Update DMX bridge firmware to publish fixture state and subscribe to commands via MQTT
- Topics: follow Apollo convention `apollo/<location>/dmx/<fixture>/state`
- In `src/lightingDmx.js`, subscribe for state, optionally switch commands to MQTT

**Test per device:** Toggle physically → verify Apollo receives state. Toggle via Apollo API → verify MQTT state published. Disconnect device → verify LWT offline arrives.

**Deployable independently:** Yes. Each device can be enabled individually. HTTP fallback remains for commands.

---

## Stage 3: Insteon State Publishing

**What:** Publish Insteon device state to MQTT from Apollo's existing event stream and re-enable device polling.

**Changes:**
- In `src/lightingInsteonListener.js`:
  - Re-enable `insteon_setup_devices()` (the disabled polling + event listener code)
  - On `turnOn`/`turnOff` events, publish to `apollo/<location>/insteon/<device_id>/state`
  - On `command` events (keypad presses), publish state
- In `src/lightingInsteon.js`:
  - After sending a command, publish the expected state (source: `command`)
- Add periodic polling (every 60s) of all Insteon devices via `hub.light(address).level()` to catch physical switch changes and publish deltas (source: `poll`)
- Handle the Hub's 200-char buffer limitation: avoid polling immediately after sending a command (add a short delay)

**Test:** Send an Insteon command via API. Verify MQTT state published. Press a physical Insteon switch. Verify Apollo receives the event and publishes state. Wait 60s, verify poll updates arrive.

**Deployable independently:** Yes. Insteon commands continue to work as before; MQTT is additive.

---

## Stage 4: Hue SSE Event Stream

**What:** Add real-time Hue state tracking via the Bridge's v2 API Server-Sent Events.

**Changes:**
- Add `philips-hue-push-client` npm package (or raw SSE connection to `/eventstream/clip/v2`)
- Create `src/lightingPhilipsHueListener.js` (following the Insteon listener pattern):
  - Connect to `https://<bridge_ip>/eventstream/clip/v2` with the existing API key
  - Handle self-signed TLS certificate
  - Parse SSE events for light/group state changes (power, brightness, color)
  - Publish to `apollo/<location>/hue/<device_id>/state`
  - Update in-memory `lights` array
- In `src/lightingPhilipsHue.js`:
  - After sending a command, publish expected state (source: `command`)
- Map Hue v2 resource IDs (UUIDs) to the v1 group/light IDs used in `lights.json`

**Polling fallback:** If SSE connection drops, fall back to polling `GET /api/<key>/lights` every 5s until SSE reconnects.

**Test:** Change a Hue light via the Hue app. Verify Apollo receives the SSE event and publishes to MQTT within 1-2 seconds.

**Deployable independently:** Yes. Hue commands unchanged; SSE is additive.

---

## Stage 5: iTach + TCP Persistent Connections

**What:** Refactor iTach and TCP device connections from connect-per-command to persistent, and add state feedback for serial devices.

**Changes:**
- Refactor `src/iTachControllers.js`:
  - Connection manager: one persistent `net.Socket` per iTach address, lazy-connect, auto-reconnect
  - Command queue: buffer commands during reconnection, send when back online
  - Parse serial device responses (e.g., PJLink `%1POWR=1`) and publish state
  - For contact closure: query state with `getstate` command, publish to MQTT
  - IR remains fire-and-forget (no state possible)
  - Publish connection health to `apollo/<location>/itach/<address>/status`
- Refactor `src/tcpServers.js`:
  - Same persistent connection pattern
  - Use existing `power_commands` config to poll device power state periodically
  - Publish state to `apollo/<location>/ip/<device_id>/state`

**Important:** iTach only allows one TCP connection per port. Persistent connections eliminate the race condition in the current code where two rapid commands can collide.

**Test:** Send two rapid commands to the same iTach unit — verify no race condition. Disconnect an iTach from the network — verify Apollo logs the error and reconnects when it comes back. Query projector power state via serial.

**Rollback:** Keep the connect-per-command code path behind a config flag (`ITACH_PERSISTENT_CONNECTIONS=true`) during transition. If persistent connections cause issues, flip the flag to revert to the old behavior without a code deploy.

**Deployable independently:** Yes, but this is a refactor — test thoroughly before deploying.

---

## Stage 6: Homebridge MQTT Integration

**What:** Bridge Homebridge accessories to the MQTT bus using `homebridge-mqttthing`, enabling HomeKit devices to participate in state tracking.

**Why its own stage:** Homebridge is a separate process with its own lifecycle. Integrating it via MQTT keeps it loosely coupled — Apollo and Homebridge don't need to know about each other directly.

**Changes:**
- Install `homebridge-mqttthing` plugin on the existing Homebridge 1.x instance
- Configure accessories in Homebridge that map to MQTT topics:
  - Door buzzer: publish lock/unlock state, subscribe to commands
  - Optionally expose Apollo-controlled devices to HomeKit (lights, shades, scenes)
- Apollo subscribes to Homebridge state topics, publishes commands when needed
- Homebridge subscribes to Apollo state topics, reflects accurate device state in HomeKit

**Topic mapping example (door buzzer):**
```json
{
  "accessory": "mqttthing",
  "type": "lockMechanism",
  "name": "Front Door",
  "topics": {
    "setLockTargetState": "apollo/entrance/homebridge/door/set",
    "getLockCurrentState": "apollo/entrance/homebridge/door/state"
  }
}
```

**Homebridge 2.0 + Matter (future note):** Homebridge 2.0 can act as a Matter bridge, exposing devices to Alexa/Google/Apple natively. This could eventually complement the custom Alexa Skill for some devices, but plugin support for Matter is not mature yet. Revisit when the Matter plugin ecosystem matures.

**Test:** Trigger the door buzzer via HomeKit. Verify MQTT state published. Verify Apollo sees the state change. Send a command from Apollo, verify HomeKit reflects the change.

**Deployable independently:** Yes. Homebridge continues to work standalone if MQTT fails.

---

## Stage 7: Alexa State Reporting via IoT Core

**What:** Bridge Mosquitto to AWS IoT Core so device state flows to the cloud. The Alexa Lambda reads IoT Core Device Shadows for ReportState (accurate answers to "is the kitchen light on?") and an IoT Rule triggers proactive ChangeReports so Echo Shows update in real-time when devices change state.

### How it works:

1. Apollo publishes state to local Mosquitto (already happening from earlier stages)
2. Mosquitto bridge forwards state topics to AWS IoT Core
3. IoT Core updates Device Shadows (one shadow per Alexa endpoint)
4. **ReportState:** Lambda reads the shadow when Alexa asks for state
5. **ChangeReport:** IoT Rule triggers a Lambda on shadow changes → Lambda sends ChangeReport to Alexa Event Gateway → Echo Shows update within seconds

### What Claude can do vs. what Ray does manually:

| Task | Who |
|------|-----|
| Mosquitto bridge config (bridge.conf) | Claude |
| IoT Core thing + certificate provisioning (AWS CLI) | Claude |
| IoT Core rules + Lambda code | Claude |
| Alexa Lambda ReportState + ChangeReport handlers | Claude |
| Discovery response updates | Claude |
| Login with Amazon OAuth app setup (developer portal) | Ray (~15 min) |
| Link Alexa account to skill (Alexa app) | Ray (~2 min) |
| IAM permissions for IoT Core (if not covered by existing creds) | Claude (CLI) |

### Changes — Mosquitto side:
- Add bridge config (`/etc/mosquitto/conf.d/iot-bridge.conf`):
  - Connect to IoT Core endpoint with X.509 certificates
  - Bridge topics: `apollo/+/+/+/state` → IoT Core
  - Use `try_private false` and `bridge_protocol_version mqttv311`
  - Certificates stored in `/etc/mosquitto/certs/`

### Changes — AWS IoT Core:
- Create one IoT **Thing per Alexa endpoint** (e.g., `apollo-kitchen-light`, `apollo-living-room-giantP`)
  - Each thing gets a classic (unnamed) shadow for its device state
  - This avoids the Named Shadow per-thing limit (25 default, requires support ticket to raise)
  - Things are provisioned via AWS CLI — Claude can script bulk creation from the device config files
- Create one IoT "thing" for the Mosquitto bridge itself (`apollo-bridge`) — used for authentication
- Generate X.509 certificate pair, attach to the bridge thing
- IoT policy: allow the bridge to publish/subscribe on `apollo/#` and `$aws/things/apollo-*/shadow/#` topics
- Topic mapping: Mosquitto bridge maps local state topics to per-device shadow update topics
  - `apollo/<location>/<ecosystem>/<device>/state` → `$aws/things/apollo-<device>/shadow/update` (reported state)
- IoT Rule: on any device shadow update, invoke the ChangeReport Lambda
  - SQL: `SELECT * FROM '$aws/things/apollo-+/shadow/update/accepted'`

### Changes — Alexa Lambda side ([Apollo-Alexa-Skill](https://github.com/raypp2/Apollo-Alexa-Skill)):
- Add `Alexa.ReportState` directive handler:
  - Read device shadow from IoT Core (`GetThingShadow` for `apollo-<endpointId>`)
  - Return `StateReport` with properties:
    - `Alexa.PowerController.powerState` (all devices)
    - `Alexa.BrightnessController.brightness` (dimmable lights)
    - `Alexa.RangeController` (shades position)
    - `Alexa.Speaker.volume` / `Alexa.Speaker.muted` (speakers)
    - `Alexa.ThermostatController.thermostatMode` (AC)
    - `Alexa.LockController.lockState` (locks)
  - Set `proactivelyReported: true` and `retrievable: true` in discovery
- Add `Alexa.ChangeReport` handler (new Lambda or same Lambda, different trigger):
  - Triggered by IoT Rule on shadow update
  - Reads the changed shadow state
  - Sends ChangeReport to Alexa Event Gateway with updated properties
  - Requires Login with Amazon OAuth token (stored in Lambda environment or Secrets Manager)
- IAM permissions: `iot:GetThingShadow` for ReportState Lambda, `iot:Publish` / `iot:Connect` for the bridge

### Login with Amazon (LWA) OAuth setup (manual — Ray):
1. Create a Login with Amazon security profile at developer.amazon.com
2. Note the Client ID and Client Secret
3. In the Alexa Developer Console, enable Account Linking for the skill
4. Set authorization URI: `https://www.amazon.com/ap/oa`
5. Set access token URI: `https://api.amazon.com/auth/o2/token`
6. Enter Client ID and Client Secret
7. In the Alexa app, link your Amazon account to the skill
8. Store the resulting refresh token for the ChangeReport Lambda

### Alexa capability interfaces:

| Device Type | Alexa Interface | Retrievable Properties |
|-------------|----------------|----------------------|
| Lights (on/off) | `Alexa.PowerController` | `powerState` |
| Lights (dimming) | `Alexa.BrightnessController` | `brightness` |
| Shades | `Alexa.RangeController` | position (0-100) |
| Speakers | `Alexa.Speaker` | `volume`, `muted` |
| AC | `Alexa.ThermostatController` | `thermostatMode` |
| Locks | `Alexa.LockController` | `lockState` |
| Scenes/Macros | `Alexa.SceneController` | None (stateless) |

**Note:** Color control (`Alexa.ColorController`) can be added when Apollo's Hue driver exposes color state via MQTT.

### Bridge monitoring:
- Mosquitto bridge publishes connection status to `apollo/bridge/iot-core/status` (online/offline)
- Set up CloudWatch alarm on IoT Core: alert if no messages received in 10 minutes
- Certificate expiry: IoT Core certificates are valid for years, but add a calendar reminder and a health check that logs days-until-expiry on Apollo startup
- If the bridge drops, Alexa state goes stale but local MQTT and all device control continue working — the bridge is not in the critical path for commands (until Stage 10)

### IoT Core cost estimate:
- ~5,000 messages/day (state updates from all devices) = ~150K messages/month
- IoT Core pricing: $1.00 per million messages
- **Estimated cost: $0.15/month** (well within free tier for first 12 months: 250K messages/month free)

**Test:** Turn on a light via physical switch → verify shadow updates in IoT Core console → verify Echo Show updates within seconds. Ask "Alexa, is the kitchen light on?" → verify correct response via ReportState. Send command via Alexa → verify SQS path still works unchanged.

**Deployable independently:** Yes. SQS command path unchanged. Mosquitto bridge and IoT Core are additive. Lambda can be deployed separately.

---

## Stage 8: Health Monitoring + Self-Diagnosis

**What:** Apollo monitors MQTT for device health and alerts when things go wrong.

**Changes:**
- Create `src/healthMonitor.js`:
  - Track last-seen timestamp for every device publishing to MQTT
  - Configurable staleness threshold per ecosystem (e.g., Shelly: 60s, Insteon poll: 120s, Hue SSE: 30s)
  - On threshold breach, publish `apollo/health/<device_id>/status` = `stale`
  - Log warnings: "Kitchen light has not reported state in 120 seconds"
- Startup connectivity check:
  - On boot, ping/query each device ecosystem
  - Publish `apollo/health/startup` with a summary of reachable/unreachable devices
- Publish health summary to `apollo/health/summary` periodically (every 5 min)
- Monitor infrastructure health (not just devices):
  - Mosquitto broker connection (`apollo/bridge/apollo/status`)
  - IoT Core bridge connection (`apollo/bridge/iot-core/status`, from Stage 7)
  - IoT Core certificate expiry — log days-until-expiry on startup, warn at 30 days
- Integrate with Uptime Kuma:
  - Push health status via Uptime Kuma's push monitor API
  - Or expose a `/api/health` endpoint that Uptime Kuma polls
  - Include bridge health in the Uptime Kuma checks

**Future (not this plan):**
- Push notifications on failure (email, Pushover, or Uptime Kuma webhook)
- Dashboard visualization of device health

**Test:** Unplug a Shelly device. Wait for staleness threshold. Verify Apollo logs the warning and publishes the stale status. Verify Uptime Kuma reflects the issue.

**Deployable independently:** Yes. Read-only monitoring, no device behavior changes.

---

## Stage 9: Real-Time Dashboard via MQTT WebSocket

**What:** Replace the dashboard's HTTP polling with direct MQTT subscriptions over WebSocket. The browser connects to Mosquitto as a first-class MQTT client and receives state updates in real-time.

**Why this approach (browser → Mosquitto directly):** No relay code in Apollo. Mosquitto's WebSocket listener (configured in Stage 1) lets the browser subscribe to topics directly. Fits the local-only philosophy — Mosquitto is on the LAN, same as the dashboard.

**Changes:**
- Add `mqtt.min.js` (browser build of mqtt.js) to `public/js/`
- Create `public/js/mqttDashboard.js`:
  - Connect to `ws://<pi-host>:9001` on page load
  - Subscribe to `apollo/#` for all state updates
  - On message, find the matching device in the AngularJS `$scope.devices` array by device ID and update its state
  - Call `$scope.$apply()` to trigger AngularJS re-render
- Update `public/index.html`:
  - Load `mqtt.min.js` and `mqttDashboard.js`
  - Remove `$interval(fetchList, 5000, 10)` polling from the `LightingDevices` controller
  - Keep the initial `$http.get('/list/...')` fetch — MQTT provides updates after load, not the initial device list
- Add connection status indicator to the nav bar (green dot = connected, red = disconnected)
- On MQTT disconnect, fall back to polling until reconnected

**What updates in real-time:**
- Light on/off state and brightness (toggle switches update without refresh)
- Device online/offline status
- Shade positions
- Health status indicators (from Stage 8)

**What doesn't change:**
- Device list and config still comes from `/list/*` endpoints at page load
- Command buttons still POST to `/api/*` (Apollo handles routing to the right protocol)
- CSS, layout, and overall structure stay as-is — this is not the full dashboard refactor

**Test:** Open dashboard in browser. Toggle a light via physical switch. Verify the dashboard switch updates within 1-2 seconds without page refresh. Disconnect Mosquitto. Verify fallback polling kicks in and connection indicator turns red. Reconnect. Verify WebSocket resumes.

**Deployable independently:** Yes. The initial HTTP fetch still works as a fallback. MQTT updates are purely additive.

---

## Stage 10: Migrate Alexa Commands from SQS to IoT Core

**What:** Replace SQS command polling with IoT Core Device Shadow "desired state" updates. Alexa commands flow through the same IoT Core infrastructure as state reporting, eliminating SQS entirely.

**How it works now (SQS):**
1. Alexa → Lambda writes command to SQS queue
2. Apollo polls SQS every 1s → receives command → executes

**How it works after (IoT Core):**
1. Alexa → Lambda writes `{"desired": {"power": "ON"}}` to the device's shadow
2. IoT Core sends shadow delta to Mosquitto via the bridge (already configured in Stage 7)
3. Apollo receives the delta as an MQTT message on `$aws/things/apollo-bridge/shadow/name/<device>/update/delta`
4. Apollo executes the command and updates the shadow "reported" state
5. Shadow desired/reported converge — command complete

**Changes:**
- Create `src/mqttCommandListener.js`:
  - Subscribe to shadow delta topics for all Alexa endpoints
  - Parse desired state changes and route to the existing `handleRequest` in `handler.js`
  - After execution, publish updated reported state to clear the delta
- Update Alexa Lambda:
  - Replace SQS `SendMessage` with IoT Core `UpdateThingShadow` (set desired state)
  - Same IAM role, add `iot:UpdateThingShadow` permission
- Remove `src/sqsListener.js` and SQS dependencies from Apollo
- Remove SQS queue from AWS (after validation period)
- Update `.env` — remove SQS config, IoT Core endpoint already configured from Stage 7

**Migration approach:** Run both paths in parallel for at least 2 weeks. Apollo listens to both SQS and shadow deltas, with logging to compare which path delivers each command. After confirming IoT Core path is reliable and within latency threshold, disable SQS in the Lambda. Keep the SQS queue alive for another week as a safety net before deletion.

**Latency threshold:** SQS long-polling delivers commands in ~1s. The IoT Core path adds network hops (Lambda → IoT Core → Mosquitto bridge → Apollo). Acceptable command latency is **under 2 seconds** end-to-end. If the IoT Core path consistently exceeds this (measure during the parallel period), investigate before committing to the migration. Light switch delays above 2s are noticeable and frustrating.

**Test:** Send Alexa command → verify it arrives via IoT Core shadow delta (not SQS). Measure end-to-end latency across 50+ commands. Verify shadow desired/reported converge after command execution. Verify no duplicate command execution during parallel running.

**Deployable independently:** Yes, with parallel running period. SQS removal is a separate step after validation.

---

## Stage 11: Dashboard Redesign

**What:** Full redesign of the web dashboard. Replace the AngularJS 1.x UI with a modern, mobile-friendly interface that takes full advantage of real-time MQTT state (from Stage 9).

**Why now:** The current dashboard was built as a quick utility but has become the primary control interface. It uses AngularJS 1.x (EOL), has no mobile layout, no room-based grouping, and no visual state feedback beyond toggle switches.

**Design goals:**
- Mobile-first responsive layout (used from phones as much as desktop)
- Room-based device grouping (leveraging the `location` field from MQTT topics)
- Visual state feedback: brightness sliders, shade position indicators, color previews
- Device health indicators (online/offline/stale from Stage 8)
- Connection status (MQTT WebSocket health)
- Spotify "now playing" card
- Fast — no heavy framework, vanilla JS or lightweight framework (Preact, Alpine.js, or similar)

**Changes:**
- Replace AngularJS with a lightweight alternative
- New layout: room cards with grouped devices, collapsible sections
- Real-time updates via MQTT WebSocket (already wired from Stage 9)
- Brightness sliders that publish to `apollo/<location>/<ecosystem>/<device>/set`
- Shade position controls
- Health dashboard section showing device status summary
- Keep the existing `/api/*` endpoints for commands — the new UI still POSTs to Apollo
- Retain `/list/*` endpoints for initial device list loading

**Test:** All device types render correctly. Toggle, brightness, and shade controls work. Real-time updates reflect within 1-2 seconds. Mobile layout is usable on phone-sized screens. Fallback to polling works when MQTT disconnects.

**Needs sub-plan before implementation:** This is the largest stage and the most prone to scope creep. Before starting, create a detailed design document covering: framework choice (with a prototype), component structure, how `/list/*` API responses map to the new UI, room layout mockups, and mobile breakpoints. The current plan captures design goals but not implementation specifics.

**Deployable independently:** Yes. Old dashboard can be preserved at `/legacy` during transition.

---

## Stage 12: Alexa Color Control

**What:** Add `Alexa.ColorController` support so Alexa can set and report color for Hue lights, WLED, and DMX fixtures.

**Dependencies:** Stage 4 (Hue SSE — need color state from the bridge), Stage 7 (IoT Core — need shadows to include color).

**Changes:**
- Extend MQTT state payload with color fields (already defined in conventions: `"color": {"hue":0,"sat":100}`)
- In `src/lightingPhilipsHue.js`: include color in state publishing and accept color commands
- In `src/lightingWled.js`: map WLED color state to/from Alexa color format
- In `src/lightingDmx.js`: map DMX RGB channels to Alexa color format
- Update IoT Core shadows to include color properties
- Update Alexa Lambda:
  - Add `Alexa.ColorController` to discovery for color-capable devices
  - Handle `SetColor` directive — write desired color to shadow
  - Include color in ReportState and ChangeReport responses
- Update dashboard (Stage 11) with color picker controls

**Test:** "Alexa, set the living room light to blue" → verify Hue light changes color. Check Echo Show displays correct color. Change color via Hue app → verify Alexa and dashboard update.

**Deployable independently:** Yes. Additive to existing power/brightness controls.

---

## Stage 13: Homebridge 2.0 + Matter

**What:** Upgrade Homebridge from 1.x to 2.0 and enable Matter bridge functionality, exposing Apollo-controlled devices natively to Apple Home, and potentially to Alexa and Google Home via Matter.

**Why:** Matter is the emerging standard for smart home interoperability. Homebridge 2.0's Matter bridge means Apollo devices can appear in Apple Home (and other Matter-compatible ecosystems) without custom plugins per platform.

**Dependencies:** Stage 6 (Homebridge MQTT integration — ensures MQTT plumbing is already working).

**Changes:**
- Upgrade Homebridge 1.x → 2.0 on the Pi
  - Verify existing plugins are compatible (check homebridge-mqttthing Matter support)
  - If homebridge-mqttthing doesn't support Matter yet, use Homebridge 2.0's built-in MQTT bridge if available, or wait for plugin updates
- Configure Matter bridge in Homebridge 2.0
- Pair Homebridge as a Matter bridge with Apple Home
- Test: devices appear in Apple Home via Matter, state syncs via MQTT

**Risk:** Homebridge 2.0 and Matter plugin ecosystem may not be fully mature. This stage should be attempted only when plugin compatibility is confirmed. The existing Homebridge 1.x + mqttthing setup (Stage 6) remains the fallback.

**Test:** Open Apple Home. Verify Apollo devices appear as Matter accessories. Toggle a light from Apple Home → verify MQTT state updates. Toggle from Apollo → verify Apple Home reflects the change.

**Deployable independently:** Yes, but with rollback plan to Homebridge 1.x if compatibility issues arise.

---

## Stage Summary

| Stage | What | Effort | Dependencies |
|-------|------|--------|-------------|
| 1 | Mosquitto + MQTT client | Small | None |
| 2 | Shelly, WLED, ESPSomfy-RTS, DMX native MQTT | Small-Medium | Stage 1 |
| 3 | Insteon state publishing | Medium | Stage 1 |
| 4 | Hue SSE event stream | Medium | Stage 1 |
| 5 | iTach + TCP persistent connections | Medium-Large | Stage 1 |
| 6 | Homebridge MQTT integration | Small-Medium | Stage 1 |
| 7 | Alexa state via IoT Core (ReportState + ChangeReport) | Medium-Large | Stages 1-4 (needs state data) |
| 8 | Health monitoring + self-diagnosis | Small-Medium | Stages 1-4 |
| 9 | Real-time dashboard via MQTT WebSocket | Small-Medium | Stage 1 + at least one device stage |
| 10 | Migrate Alexa commands SQS → IoT Core | Medium | Stage 7 |
| 11 | Dashboard redesign | Medium-Large | Stage 9 |
| 12 | Alexa color control | Medium | Stages 4, 7 |
| 13 | Homebridge 2.0 + Matter | Small-Medium | Stage 6 |

**Ordering flexibility:**
- Stages 2-6 and 9 can be done in any order after Stage 1
- Stage 7 benefits from having several ecosystems publishing state
- Stage 8 can start after Stage 1, improves with more device stages
- Stage 10 requires Stage 7 (IoT Core must be running)
- Stage 11 can start after Stage 9 but benefits from Stages 8 and 12
- Stage 12 requires Stages 4 and 7
- Stage 13 should wait until Homebridge 2.0 Matter plugins are confirmed compatible

## Spotify (part of Stage 9)

Spotify state publishing is bundled with Stage 9 (dashboard WebSocket updates) since it's small and the dashboard is its primary consumer. Poll `getMyCurrentPlaybackState()` on a 10-second timer and publish to `apollo/home/spotify/player/state` with a payload including track name, artist, album art URL, playback state, and device name. The dashboard (Stage 9 or 11) renders a "now playing" card from this topic.

## Long-Term Architecture

Apollo remains the core system. MQTT + IoT Core make it self-diagnosing, Alexa-accurate, and maintainable with AI-assisted development (Claude Code). No migration to Home Assistant or other platforms planned.

**Durable investments:**
- Mosquitto broker + MQTT topic conventions
- Native MQTT device configurations (Shelly, WLED, ESPSomfy-RTS, DMX)
- IoT Core Device Shadows + Alexa integration (state and commands)
- Health monitoring infrastructure
- Modern dashboard consuming MQTT state

**Future possibilities (not planned, but enabled by this architecture):**
- Remote access via IoT Core (subscribe to topics from anywhere)
- Push notifications on device failures (Pushover, email)
- Additional Alexa capabilities (scenes as stateful, thermostat modes)
- Voice-triggered automations via Alexa routines backed by MQTT

## Not in Scope

- **Home Assistant migration** — Apollo is the long-term system
- **Cloud MQTT broker** — Mosquitto stays local; IoT Core handles only the Alexa bridge
- **Google Home integration** — may come for free via Matter (Stage 13), otherwise not planned
