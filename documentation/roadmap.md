[Overview](../README.md) &nbsp;&nbsp;&nbsp;|&nbsp;&nbsp;&nbsp; [🧭 Installation](./installation.md) &nbsp;&nbsp;&nbsp;|&nbsp;&nbsp;&nbsp; [🛠️ Maintenance](./maintenance.md) &nbsp;&nbsp;&nbsp;|&nbsp;&nbsp;&nbsp; <u>🔮 Roadmap</u>

## Active: MQTT Implementation (Staged Rollout)

See [mqtt-implementation-plan.md](./mqtt-implementation-plan.md) for the full 13-stage plan.

Adds a unified MQTT state and command bus, real-time Alexa state reporting via AWS IoT Core, health monitoring, dashboard redesign, and more. Each stage is independently deployable and testable.

## To Fix

1. Fix Away Scene
2. Fix Office Lighting Scene
3. DMX Update
   - Make manual off turn the fixture off
   - Update scenes via JSON push
4. Troubleshoot Echo Link inconsistently connecting to receiver
5. Insteon keypad
   - Button blink groups
   - [Multi-linking keypads](https://www.youtube.com/watch?v=ZbWiIS6Tuzw)
6. Blackout shades
   - Reinstall shade 1
7. Projector reliability
   - Watch for reliability issues with projector DHCP. It seems to lose IP for no apparent reason and must be toggled.

## Roadmap Functionality

1. Somfy STOP position capability / halfway command
2. DMX Controller
   - Add support for dimming
   - Add support for color
3. Create macro off commands (e.g., turn off Movie Mode)
4. Mood lighting — rotate color slowly via built-in WLED/Hue API
5. Morning shade automation for bedroom (rise with the sun)
6. Email/Push notification of failures (Pushover or Uptime Kuma webhook)

## Completed / Superseded

- ~~Fix PM2 Monitor Setup~~ — Done
- ~~Replace bedroom switch~~ — Done
- ~~Catch error on timeout connection to devices~~ — Fixed (GitHub Issues #1, #2)
- ~~Consider implementing MQTT~~ — Active (see MQTT implementation plan)
- ~~Alexa Smart Home Skills: light colors, push failure response~~ — Covered by MQTT plan Stages 7, 12
- ~~Improve Apple HomeKit bridge support~~ — Covered by MQTT plan Stage 6 (Homebridge MQTT) and Stage 13 (Matter)
- ~~Ping devices at startup~~ — Covered by MQTT plan Stage 8 (health monitoring)
- ~~Better setup of serial commands (queue, delays, persistent connections)~~ — Covered by MQTT plan Stage 5 (iTach refactor)
- ~~Integration with Home Assistant~~ — Not planned; Apollo is the long-term system
- ~~Deploy AUTH for web application~~ — Not needed; Pi and IoT devices on separate VLANs
- ~~Install Ring Video Doorbell~~ — Obsolete
- ~~BeagleBone references~~ — Decommissioned May 2026
- ~~Alexa direct via ngrok~~ — Not pursuing; SQS → IoT Core migration (MQTT plan Stage 10)
- ~~Bridge Siri commands via Homebridge~~ — Already running Homebridge; MQTT integration in Stage 6
- ~~Add color capabilities from Alexa API~~ — MQTT plan Stage 12
