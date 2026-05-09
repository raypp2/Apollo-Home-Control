# TODO — Known Bugs

Active bugs found during the BeagleBone → Raspberry Pi 5 migration audit (2026-05-08). Filed here rather than in `documentation/roadmap.md` because both have measurable user impact and are low-effort fixes.

## 1. `LIGHTS` API endpoint never closes the HTTP response

**Symptom:** `GET /api/lights/<device>/<command>` causes the client to hang until it times out (5s+). Returns `HTTP 000` to curl. The Insteon command is dispatched correctly and the device responds — only the response-close is missing.

**Cause:** In `src/handler.js`, the `LIGHTS` case calls `lighting_device_command(operation_num, apiDevice, apiCommand)` and returns immediately. That function doesn't take a `response` object, so `response.end()` is never called. Compare to `handleDevice()` (line ~222) which correctly ends the response after dispatch.

**Why it's been invisible:** Alexa via SQS doesn't wait for an HTTP response — that path uses `sqsListener.js`, not the API endpoint. The bug only surfaces when calling `/api/lights/...` directly from a browser, curl, or any HTTP client.

**Fix:** In `src/handler.js`, add `if (typeof response != 'undefined') { response.end("Completed processing request."); }` after the `lighting_device_command()` call in the `LIGHTS` case. Same pattern for `LIGHTINGSCENES` (also affected — `scene_command()` doesn't take a response either).

**File:** `src/handler.js`, around lines 93–99.

---

## 2. Apollo crashes on unhandled Insteon connection errors (extends roadmap item 10)

**Symptom:** When the Insteon Hub becomes unreachable (firewall change, hub power-cycle, router reboot, VLAN routing failure), the next Insteon command throws `Error: connect EHOSTUNREACH` from inside the `home-controller` library and is uncaught. Apollo crashes. PM2 restarts it, the listener reconnects (or doesn't), and on the next Insteon command the cycle repeats.

**Observed:** May 8 2026. Bone could not reach `192.168.30.10:25105` after a VLAN change. Apollo log shows ~30 minutes of restart-loop pattern: `SQS Listener Started` → `HTTP Server listening on port 80` → `EHOSTUNREACH` → process exit. Every Alexa command lost during that window.

**Why it's worse than it looks:** When Apollo crashes on Insteon failure, it takes down DMX, Hue, Shelly, WLED, Spotify, Find-My, Somfy, iTach, and the local web UI with it. A single misbehaving ecosystem brings down all of them.

**Roadmap note:** Item 10 in `documentation/roadmap.md` already mentions this for serial and somfy-bridge devices. Insteon belongs in the same category — wrap the `home-controller` listener and the per-command HTTP requests so a connect failure doesn't kill the process.

**Fix sketch:**
- Wrap `hub.httpClient(config, callback)` in `src/lightingInsteonListener.js` with error handling for the persistent connection.
- Add `process.on('uncaughtException', ...)` as a backstop in `index.js` (log and continue, don't exit) — defensible for a single-purpose home controller; would be wrong in a financial app.
- Optionally: per-command timeout + retry for `insteon_send_command()` in `src/lightingInsteon.js` so a one-off Hub blip doesn't even surface as an error.

**Files:** `src/lightingInsteonListener.js`, `src/lightingInsteon.js`, `index.js`.

**Priority:** After the Pi migration. The Pi will inherit the same vulnerability — fixing it before cutover is nice-to-have, after cutover is fine.
