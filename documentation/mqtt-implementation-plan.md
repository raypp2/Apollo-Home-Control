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

**Why keep SQS for commands:** SQS works reliably for command delivery from Alexa and costs nothing. IoT Core shadow "desired state" could replace it eventually, but there's no urgency — SQS is proven and simple.

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
| `device_id` | Device ID from config files | `kitchen`, `giantP`, `shades`, `bedroomProjector` |
| `attribute` | State or control channel | `state`, `set`, `status`, `brightness`, `position` |

**Examples:**
```
apollo/kitchen/insteon/kitchen/state          # Kitchen Insteon dimmer state
apollo/living-room/hue/giantP/state           # Living room Hue light state
apollo/bedroom/somfy/shades/state             # Bedroom shade position
apollo/theater/itach/theaterProjector/status   # iTach connection health
apollo/bridge/apollo/status                    # Apollo bridge online/offline
```

### Retained Messages

All `state` topics use **retained messages** so that new subscribers (dashboard, health monitor, reconnecting clients) immediately get the last known state.

### State Payload Format

All state messages use JSON:

```json
{
  "power": "ON",
  "brightness": 80,
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
| `timestamp` | Unix epoch (seconds) | Yes | When this state was observed |
| `source` | `"command"` / `"event"` / `"poll"` | Yes | How we know this state |

`source` values:
- `command` — Apollo sent a command and assumes the resulting state
- `event` — device reported a state change (SSE, native MQTT, Insteon event)
- `poll` — periodic device query confirmed this state

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

---

## Stage 1: Mosquitto Broker + MQTT Client in Apollo

**What:** Install Mosquitto on the Pi, add an MQTT client to Apollo that connects at startup. No device integration yet — just the plumbing.

**Changes:**
- Install Mosquitto on Pi (`apt install mosquitto mosquitto-clients`)
- Configure Mosquitto for local-only access (listener on `localhost:1883` or LAN-only)
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
- Topics: `shellies/<model>-<id>/relay/0` (state), `shellies/<model>-<id>/relay/0/command` (set)
- In `src/lightingShelly.js`, subscribe and translate to Apollo topic convention

### WLED
- Enable MQTT in WLED settings, point to Mosquitto broker
- Topics: `wled/<id>/v` (state JSON), `wled/<id>/api` (commands)
- In `src/lightingWled.js`, subscribe and translate

### ESPSomfy-RTS
- Enable MQTT in ESPSomfy-RTS Network settings (web UI)
- Set root topic (e.g., `espsomfy`)
- Topics published: `espsomfy/shades/<id>/position` (0-100), `espsomfy/shades/<id>/direction` (-1/0/1), `espsomfy/shades/<id>/name`, `espsomfy/shades/<id>/tiltPosition`
- Topics subscribed: `espsomfy/shades/<id>/direction/set`, `espsomfy/shades/<id>/target/set` (0-100%)
- Also publishes `status` (online/offline via LWT), firmware, IP address
- In `src/somfyBridge.js`, subscribe and translate. Can optionally switch commands from HTTP to MQTT.

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
- Create IoT "thing" for the Mosquitto bridge (one thing, not per-device)
- Generate X.509 certificate pair and attach to the thing
- IoT policy: allow publish/subscribe on `apollo/#` topics
- Create a **Named Shadow** per Alexa endpoint (e.g., shadow name = endpoint ID)
- IoT Rule: on shadow update, invoke the ChangeReport Lambda
  - SQL: `SELECT * FROM '$aws/things/apollo-bridge/shadow/name/+/update/accepted'`

### Changes — Alexa Lambda side ([Apollo-Alexa-Skill](https://github.com/raypp2/Apollo-Alexa-Skill)):
- Add `Alexa.ReportState` directive handler:
  - Read device shadow from IoT Core (`GetThingShadow`)
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
- Integrate with Uptime Kuma:
  - Push health status via Uptime Kuma's push monitor API
  - Or expose a `/api/health` endpoint that Uptime Kuma polls

**Future (not this plan):**
- Push notifications on failure (email, Pushover, or Uptime Kuma webhook)
- Dashboard visualization of device health

**Test:** Unplug a Shelly device. Wait for staleness threshold. Verify Apollo logs the warning and publishes the stale status. Verify Uptime Kuma reflects the issue.

**Deployable independently:** Yes. Read-only monitoring, no device behavior changes.

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

Stages 2-6 can be done in any order after Stage 1. Stage 7 benefits from having several ecosystems publishing state. Stage 8 can be added at any point after Stage 1.

## Spotify

Not part of the staged MQTT rollout. Spotify state (`getMyCurrentPlaybackState()`) will be polled on a timer and published to `apollo/home/spotify/<device_id>/state` for the dashboard "now playing" feature. Can be added at any stage after Stage 1.

## Long-Term Architecture

Apollo remains the core system. MQTT + IoT Core make it self-diagnosing, Alexa-accurate, and maintainable with AI-assisted development (Claude Code). No migration to Home Assistant or other platforms planned.

**Durable investments (will last):**
- Mosquitto broker + MQTT topic conventions
- Native MQTT device configurations (Shelly, WLED, ESPSomfy-RTS, DMX)
- IoT Core Device Shadows + Alexa integration
- Health monitoring infrastructure

**Future possibilities (not planned, but enabled by this architecture):**
- Dashboard rewrite consuming MQTT state via WebSocket
- Remote access via IoT Core (subscribe to topics from anywhere)
- Additional Alexa capabilities (color control, scenes as stateful)
- Homebridge 2.0 + Matter (when plugin ecosystem matures)
- Push notifications on device failures (Pushover, email)

## Not in Scope

- **Dashboard HTML refactor** — separate project, will consume MQTT state when ready
- **Alexa color control** — can be added when Apollo's Hue driver exposes color state via MQTT
- **Homebridge 2.0 upgrade** — revisit when Matter plugin ecosystem matures
- **Replacing SQS with IoT Core for commands** — SQS works, no reason to change
