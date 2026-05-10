# Apollo Home Control — Claude Code project context

## What this is

Single-process Node.js home control bridge. Routes commands from Alexa (via AWS SQS), a local API, and Insteon KeyPad button presses to physical devices over the network: Insteon, Philips Hue, GlobalCache iTach (IR / serial / contact-closure), ESPSomfy-RTS, Shelly, WLED, DMX, Spotify, Apple Find-My, plus Homebridge as a separate service for HomeKit door buzzer.

Single-owner, single-install. No tests, no CI, deployed by rsync.

## Codebase shape

- `index.js` — entry point. Loads JSON5 config files, starts the web server, SQS listener, and Insteon listener.
- `src/handler.js` — central command router. Switches on the first segment of the API path (DEVICES, LIGHTS, LIGHTINGSCENES, MACROS, SPEAKERS, AC, LOCKS, DEVICESCENES) and dispatches to per-ecosystem modules.
- `src/lighting.js` + `src/lightingInsteon.js` + `src/lightingInsteonListener.js` + `src/lightingPhilipsHue.js` + `src/lightingDmx.js` + `src/lightingShelly.js` + `src/lightingWled.js` — per-protocol lighting drivers.
- `src/iTachControllers.js` — TCP to GlobalCache iTach controllers for serial, IR, and contact-closure.
- `src/somfyBridge.js` — HTTP to ESPSomfy-RTS bridge for shades.
- `src/spotify.js`, `src/findMy.js`, `src/alexaSpeaker.js`, `src/alexaAC.js` — single-purpose modules.
- `src/tcpServers.js` — generic IP-control device sender used by handler.
- `src/sqsListener.js` — long-polls AWS SQS, dispatches messages to `handleRequest`.
- `src/webServer.js` — Express on port 80; serves the static `public/` UI and exposes `/api/<MODULE>/<DEVICE>/<COMMAND>/<P1>/<P2>`.
- `src/alexaTriggers.js` — generates `config/triggers.json` at startup from the other configs (used by the Apollo Alexa Skill Lambda).
- `config/*.json` — runtime config. Personal versions are gitignored; `*.example` files are committed as templates.
- `public/` — static UI (HTML, CSS, fonts, JS). Served at `/`.

## Running

- Node 20.x, npm 10.x.
- On Linux, port 80 needs `sudo setcap cap_net_bind_service=+ep $(readlink -f $(which node))`.
- Install: `npm ci` (or `npm install`).
- Start (dev): `node index.js`.
- Start (prod): `pm2 start ecosystem.config.js`.
- Required config: copy each `config/*.json.example` to `config/*.json` and edit, plus `.env` from `sample.env`.

## Coding patterns to know

- **JSON5 config files** — `config/*.json` are parsed with the `json5` library so they may contain comments and trailing commas. Don't switch them to strict JSON without checking how Apollo loads them.
- **Modules import shared state from `index.js`** — pattern `const { devices, lights, ... } = require('../index')`. Module loading order matters; `index.js` exports state before `require`-ing handlers.
- **Command paths** — both the local `/api` route and the SQS payload format use the same `/MODULE/DEVICE/COMMAND/PARAM1/PARAM2` shape. Adding a module means a new `case` in `handler.js`.
- **Logging convention** — every command gets a numeric `operation_num` (incrementing) prefixed to log lines (`%d - ...`). Easy to grep a single command's lifecycle in `apollo.log`.

## Known bugs and feature work

Tracked as [GitHub Issues](https://github.com/raypp2/Apollo-Home-Control/issues). When you discover a bug, file it as an issue rather than adding to a TODO file. When you fix it, reference the issue number in the commit message (e.g., `Fix LIGHTS API hang (#12)`) so GitHub auto-closes it.

## Personal deployment context

This repo is paired with a private repo `Apollo-Home-Control-private` (cloned as a sibling directory) containing personal config files (devices, lights, scenes, macros, keypad bindings) and a deployment-specific context document. If you're working on deployment-related code, integrating with the live install, or troubleshooting the Pi, read:

```
../apollo-home-control-private/pi-deployment-context.md
```

That document covers the running deployment: host info, network topology, the Homebridge install pinned to 1.x for plugin compat, Uptime Kuma monitoring, the ESPSomfy bridge that blocks ICMP but accepts HTTP, etc. None of that is in this public repo.

For code-only work (fixing a bug in a handler, adding an ecosystem driver), you can ignore the private repo entirely — Apollo runs locally just fine off the templates plus your own `.env`.

## Roadmap

`documentation/roadmap.md` — bigger-picture wishlist. Older than `TODO.md`; some items are out of date (PM2 monitor setup is done, BeagleBone references are obsolete since the BeagleBone was decommissioned in May 2026 and Apollo now runs on a Raspberry Pi 5).
