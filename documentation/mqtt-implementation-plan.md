# MQTT Implementation Plan — Staged Rollout

## Goal

Add a unified MQTT state and command bus to Apollo so that:
1. Every device ecosystem publishes its current state
2. Apollo can detect when devices stop responding
3. Alexa can query and display accurate device state via ReportState and proactive ChangeReports
4. The system self-diagnoses failures instead of waiting for the user to notice

## Architecture

```
          ┌─────────────────────────────────────┐
          │         Alexa Smart Home            │
          │  ReportState ◄── IoT Shadow read    │
          │  ChangeReport ◄── IoT Rule trigger  │
          │  Directives ──► IoT Shadow desired  │
          └──────────────────┬──────────────────┘
                             │
                    ┌────────▼────────┐
                    │  AWS IoT Core   │
                    │  Device Shadows │
                    └────────┬────────┘
                             │ MQTT (TLS)
                             │
┌──────────────┐    ┌────────▼────────┐    ┌──────────────┐
│  Mosquitto   │◄──►│     Apollo      │───►│ Uptime Kuma  │
│  (local)     │    │   (index.js)    │    │ (monitoring) │
└──────┬───────┘    └────────┬────────┘    └──────────────┘
       │                     │
       │ native MQTT    commands via
       │                HTTP/TCP/serial
       │                     │
  ┌────▼─────────┐   ┌──────▼──────────┐
  │ Shelly, WLED │   │ Insteon, Hue,   │
  │ ESPSomfy-RTS │   │ iTach, TCP/IP   │
  │ DMX Bridge   │   │                 │
  └──────────────┘   └─────────────────┘
```

Apollo connects to **two MQTT brokers**: Mosquitto (local, for device communication) and AWS IoT Core (cloud, for Alexa integration). All local device topics flow through Mosquitto. Apollo bridges relevant state to IoT Core shadows.

---

## MQTT Conventions

### Topic Hierarchy

```
apollo/<location>/<ecosystem>/<device_id>/<attribute>
```

**Why location first:** Groups devices by physical space for easier monitoring, dashboard views, and automation rules. A location-first hierarchy means subscribing to `apollo/living-room/#` gives you everything in that room regardless of ecosystem.

| Level | Values | Examples |
|-------|--------|---------|
| `location` | Room or zone from device config | `living-room`, `bedroom`, `kitchen`, `theater`, `office`, `outdoor` |
| `ecosystem` | Protocol/platform | `insteon`, `hue`, `shelly`, `wled`, `somfy`, `dmx`, `itach`, `ip`, `spotify` |
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
- Topics: `espsomfy/shades/<id>/position` (0-100), `espsomfy/shades/<id>/direction` (-1/0/1), `espsomfy/shades/<id>/direction/set` (commands)
- ESPSomfy also publishes `status` (online/offline via LWT), firmware version, IP address
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

## Stage 6: Alexa Integration via AWS IoT Core

**What:** Replace the one-way SQS command path with bidirectional AWS IoT Core Device Shadows. This gives Alexa both command delivery and state reporting through a single channel.

**Why IoT Core over DynamoDB:** IoT Core is purpose-built for this. Device Shadows store desired + reported state natively. IoT Rules can trigger the Lambda for proactive ChangeReports. It's the architecture AWS recommends for Alexa Smart Home Skills with local devices. Cost is effectively free for a single home (~$1/million messages).

**Why not keep SQS:** SQS was the right choice when the skill was command-only. Now that state reporting is a goal, IoT Core provides both directions in one service. SQS can run in parallel during migration.

### Architecture

```
Alexa ──► Lambda ──► IoT Shadow (desired) ──► Apollo (via MQTT subscribe)
Alexa ◄── Lambda ◄── IoT Shadow (reported) ◄── Apollo (via MQTT publish)
Alexa ◄── Event Gateway ◄── IoT Rule ──► Lambda (proactive ChangeReports)
```

### Changes — Apollo side:
- Add `aws-iot-device-sdk-v2` npm package
- Create `src/iotCoreBridge.js`:
  - Connect to AWS IoT Core via MQTT (TLS, X.509 certificates)
  - For each Alexa-exposed device, maintain an IoT Thing Shadow
  - Subscribe to shadow delta topics (desired state changes from Alexa)
  - On local state changes (from Mosquitto), update the shadow's reported state
  - Bridge: subscribe to local `apollo/+/+/+/state`, publish to IoT shadow
- Provision IoT Thing + certificates via AWS CLI or console
- Add `.env` vars: `IOT_ENDPOINT`, `IOT_CERT_PATH`, `IOT_KEY_PATH`, `IOT_CA_PATH`

### Changes — Alexa Lambda side (separate repo):
- **ReportState handler:** On `Alexa.ReportState`, read the IoT Device Shadow's `reported` state, return `StateReport`
- **Command delivery:** On power/brightness directives, update the shadow's `desired` state (instead of or in addition to SQS)
- **Proactive ChangeReports (optional, requires account linking):**
  - IoT Rule triggers Lambda when shadow `reported` state changes
  - Lambda sends `Alexa.ChangeReport` to Alexa Event Gateway with LWA OAuth token
  - Requires Login with Amazon account linking in the skill

### Migration path:
1. Deploy IoT Core bridge for **state reporting only** (Apollo publishes reported state)
2. Add ReportState handler to Lambda (reads shadow)
3. Keep SQS for commands initially — both paths work in parallel
4. Once stable, optionally migrate commands from SQS to shadow desired state
5. Add proactive ChangeReports (requires account linking)

**Test:** Turn on a light via Alexa. Verify shadow `reported` state updates. Ask Alexa "is the kitchen light on?" — verify correct response. Change light via physical switch — verify shadow updates via the Insteon/Hue event stream.

**Deployable independently:** Yes. SQS continues working. IoT Core is additive.

---

## Stage 7: Health Monitoring + Self-Diagnosis

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
| 6 | Alexa via AWS IoT Core | Large | Stages 1-4 (needs state data flowing) |
| 7 | Health monitoring | Small-Medium | Stages 1-4 |

Stages 2, 3, and 4 can be done in any order after Stage 1. Stage 5 is independent. Stage 6 benefits from having several ecosystems publishing state. Stage 7 can be added at any point after Stage 1.

## Spotify

Not part of the staged MQTT rollout. Spotify state (`getMyCurrentPlaybackState()`) will be polled on a timer and published to `apollo/home/spotify/<device_id>/state` for the dashboard "now playing" feature. Can be added at any stage after Stage 1.

## Not in Scope

- **Dashboard HTML refactor** — separate project, will consume MQTT state when ready
- **Proactive Alexa ChangeReports** — future upgrade after ReportState works (requires OAuth account linking with Login with Amazon)
