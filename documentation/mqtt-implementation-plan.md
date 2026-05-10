# MQTT Implementation Plan — Staged Rollout

## Goal

Add a unified MQTT state and command bus to Apollo so that:
1. Every device ecosystem publishes its current state
2. Apollo can detect when devices stop responding
3. Alexa can query and display accurate device state
4. The system self-diagnoses failures instead of waiting for the user to notice

## Architecture

```
                          ┌─────────────────┐
                          │  Alexa Lambda    │
                          │  (ReportState)   │
                          └───────┬─────────┘
                                  │ read
                          ┌───────▼─────────┐
                          │    DynamoDB      │
                          │  (state cache)   │
                          └───────▲─────────┘
                                  │ write
┌──────────────┐          ┌───────┴─────────┐
│  Mosquitto   │◄────────►│     Apollo      │
│   Broker     │  pub/sub │   (index.js)    │
└──────┬───────┘          └───────┬─────────┘
       │                          │
       │ native MQTT        commands via
       │                   HTTP/TCP/serial
       │                          │
  ┌────▼────┐             ┌───────▼─────────┐
  │ Shelly  │             │ Insteon, Hue,   │
  │ WLED    │             │ iTach, Somfy,   │
  │         │             │ DMX, Spotify    │
  └─────────┘             └─────────────────┘
```

**Topic convention:** `apollo/<ecosystem>/<device_id>/state` and `apollo/<ecosystem>/<device_id>/set`

**State payload format (JSON):**
```json
{
  "power": "ON",
  "brightness": 80,
  "timestamp": 1715300000,
  "source": "event"
}
```
`source` can be `command` (Apollo sent it), `event` (device reported it), or `poll` (periodic query).

---

## Stage 1: Mosquitto Broker + MQTT Client in Apollo

**What:** Install Mosquitto on the Pi, add an MQTT client to Apollo that connects at startup. No device integration yet — just the plumbing.

**Changes:**
- Install Mosquitto on Pi (`apt install mosquitto`)
- Add `mqtt` npm package to Apollo
- Create `src/mqttClient.js` — connects to broker, exports `publish(topic, payload)` and `subscribe(topic, callback)`. Handles reconnection.
- Add `.env` vars: `MQTT_BROKER_URL=mqtt://localhost:1883`
- Wire into `index.js` — connect on startup, log connection status
- Publish `apollo/bridge/status` = `online` on connect (with last-will `offline`)

**Test:** Start Apollo, verify Mosquitto receives the bridge status message. Use `mosquitto_sub -t 'apollo/#' -v` to watch.

**Deployable independently:** Yes. No device behavior changes.

---

## Stage 2: Shelly + WLED (Native MQTT — Quick Wins)

**What:** Enable MQTT on Shelly and WLED devices (firmware setting), subscribe in Apollo, update `lights` state array.

**Changes:**
- Configure each Shelly device's MQTT settings via its web UI (point to Mosquitto broker)
- Configure each WLED instance's MQTT settings via its web UI
- In `src/lightingShelly.js`, subscribe to Shelly state topics. Update the in-memory `lights` array with actual relay state.
- In `src/lightingWled.js`, subscribe to WLED state topics. Update the in-memory `lights` array.
- Publish commands via MQTT as an alternative to HTTP (optional — can keep HTTP commands and just listen for state).

**Shelly MQTT topics:**
- State: `shellies/<model>-<id>/relay/0` → `on` or `off`
- Command: `shellies/<model>-<id>/relay/0/command` → `on` or `off`

**WLED MQTT topics:**
- State: `wled/<id>/v` → JSON with state
- Command: `wled/<id>/api` → WLED JSON API payload

**Test:** Toggle a Shelly switch physically. Verify Apollo logs the state change. Check `mosquitto_sub`. Toggle via Apollo API, verify MQTT state updates.

**Deployable independently:** Yes. Shelly/WLED continue to work via HTTP if MQTT fails.

---

## Stage 3: Insteon State Publishing

**What:** Publish Insteon device state to MQTT from Apollo's existing event stream and re-enable device polling.

**Changes:**
- In `src/lightingInsteonListener.js`:
  - Re-enable `insteon_setup_devices()` (the disabled polling + event listener code)
  - On `turnOn`/`turnOff` events, publish to `apollo/insteon/<device_id>/state`
  - On `command` events (keypad presses), publish to `apollo/insteon/<device_id>/state`
- In `src/lightingInsteon.js`:
  - After sending a command, publish the expected state to MQTT (source: `command`)
- Add periodic polling (every 60s) of all Insteon devices via `hub.light(address).level()` to catch physical switch changes and publish deltas (source: `poll`)

**Test:** Send an Insteon command via API. Verify MQTT state published. Press a physical Insteon switch. Verify Apollo receives the event and publishes state. Wait 60s, verify poll updates arrive.

**Deployable independently:** Yes. Insteon commands continue to work as before; MQTT is additive.

---

## Stage 4: Hue SSE Event Stream

**What:** Add real-time Hue state tracking via the Bridge's v2 API Server-Sent Events.

**Changes:**
- Add `philips-hue-push-client` npm package (or raw SSE via `https` module)
- Create `src/lightingPhilipsHueListener.js` (following the Insteon listener pattern):
  - Connect to `https://<bridge_ip>/eventstream/clip/v2` with the existing API key
  - Parse SSE events for light/group state changes
  - Publish to `apollo/hue/<device_id>/state`
  - Update in-memory `lights` array
- In `src/lightingPhilipsHue.js`:
  - After sending a command, publish expected state (source: `command`)
- Map Hue v2 resource IDs to the v1 group/light IDs used in `lights.json`
- Add `.env` var: `PHILIPS_HUE_BRIDGE_IP` (may already exist as `PHILIPS_HUE_IP`)

**Polling fallback:** If SSE connection drops, fall back to polling `GET /api/<key>/lights` every 5s until SSE reconnects.

**Test:** Change a Hue light via the Hue app. Verify Apollo receives the SSE event and publishes to MQTT within 1-2 seconds.

**Deployable independently:** Yes. Hue commands unchanged; SSE is additive.

---

## Stage 5: iTach + TCP Persistent Connections

**What:** Refactor iTach and TCP device connections from connect-per-command to persistent, and add state feedback for serial devices.

**Changes:**
- Refactor `src/iTachControllers.js`:
  - Connection pool: one persistent `net.Socket` per iTach address, lazy-connect, auto-reconnect
  - Queue commands when reconnecting
  - Parse serial device responses (e.g., PJLink `%1POWR=1`) and publish state
  - For contact closure: query state with `getstate` command, publish to MQTT
  - IR remains fire-and-forget (no state possible)
- Refactor `src/tcpServers.js`:
  - Same persistent connection pattern
  - Use existing `power_commands` config to poll device power state periodically
  - Publish state to `apollo/ip/<device_id>/state`
- Publish connection health to `apollo/itach/<address>/status` (online/offline/error)

**Test:** Send two rapid commands to the same iTach unit — verify no race condition. Disconnect an iTach from the network — verify Apollo logs the error and reconnects when it comes back. Query projector power state via serial.

**Deployable independently:** Yes, but this is a refactor — test thoroughly before deploying.

---

## Stage 6: Alexa State Reporting via DynamoDB

**What:** Apollo writes device state to DynamoDB on every state change. The Alexa Lambda reads it on `ReportState` directives.

**Why DynamoDB:** Apollo already has AWS credentials for SQS. DynamoDB is free tier, requires no tunnel/ngrok, no OAuth token management. Simplest viable path.

**Changes — Apollo side:**
- Add `@aws-sdk/client-dynamodb` (or `@aws-sdk/lib-dynamodb`) as dependency
- Create `src/alexaStateReporter.js`:
  - On any MQTT state change (subscribe to `apollo/+/+/state`), write to DynamoDB table `ApolloDeviceState`:
    ```
    Key: { endpointId: "kitchen" }
    Attributes: { powerState: "ON", brightness: 80, timestamp: 1715300000 }
    ```
  - Batch writes where possible to reduce API calls
  - Map internal device IDs to Alexa endpoint IDs (from `triggers.json`)

**Changes — Alexa Lambda side (separate repo):**
- Handle `Alexa.ReportState` directive:
  - Read device state from DynamoDB
  - Return `StateReport` with `Alexa.PowerController.powerState` and optionally `Alexa.BrightnessController.brightness`
- Add IAM permissions for DynamoDB read

**DynamoDB table design:**
- Table name: `ApolloDeviceState`
- Partition key: `endpointId` (string)
- No sort key needed (one row per device)
- TTL attribute: `expiresAt` (auto-expire stale state after 24h)

**Test:** Turn on a light via Alexa. Check DynamoDB row. Ask Alexa "is the kitchen light on?" — verify correct response. Change light via physical switch — verify DynamoDB updates via the Insteon/Hue event stream.

**Deployable independently:** Yes. The DynamoDB writes are additive. The Lambda ReportState handler can be deployed separately.

---

## Stage 7: Health Monitoring + Self-Diagnosis

**What:** Apollo monitors MQTT for device health and alerts when things go wrong.

**Changes:**
- Create `src/healthMonitor.js`:
  - Track last-seen timestamp for every device publishing to MQTT
  - Configurable staleness threshold per ecosystem (e.g., Shelly: 60s, Insteon poll: 120s)
  - On threshold breach, publish `apollo/health/<device_id>/status` = `stale`
  - Log warnings: "Kitchen light has not reported state in 120 seconds"
- Startup connectivity check:
  - On boot, ping/query each device ecosystem
  - Publish `apollo/health/startup` with a summary of reachable/unreachable devices
- Publish health summary to `apollo/health/summary` periodically (every 5 min)

**Future (not this plan):**
- Push notifications on failure (email, Pushover, or Uptime Kuma webhook)
- Dashboard visualization of device health

**Test:** Unplug a Shelly device. Wait for staleness threshold. Verify Apollo logs the warning and publishes the stale status.

**Deployable independently:** Yes. Read-only monitoring, no device behavior changes.

---

## Stage Summary

| Stage | What | Effort | Dependencies |
|-------|------|--------|-------------|
| 1 | Mosquitto + MQTT client | Small | None |
| 2 | Shelly + WLED native MQTT | Small | Stage 1 |
| 3 | Insteon state publishing | Medium | Stage 1 |
| 4 | Hue SSE event stream | Medium | Stage 1 |
| 5 | iTach + TCP persistent connections | Medium-Large | Stage 1 |
| 6 | Alexa state reporting (DynamoDB) | Medium | Stages 1-4 (needs state data) |
| 7 | Health monitoring | Small-Medium | Stages 1-4 |

Stages 2, 3, and 4 can be done in any order after Stage 1. Stage 5 is independent. Stage 6 needs at least some devices publishing state. Stage 7 can be added at any point after Stage 1.

## Not in Scope

- **Dashboard HTML refactor** — separate project, will consume MQTT state when ready
- **Somfy state tracking** — pending investigation of ESPSomfy-RTS firmware MQTT support
- **Proactive Alexa ChangeReports** — future upgrade after DynamoDB-based ReportState proves out (requires OAuth account linking)
- **DMX state tracking** — Ray will update the bridge firmware separately
- **Spotify "now playing"** — polling `getMyCurrentPlaybackState()` on a timer, publishing to MQTT. Can be added at any stage.
