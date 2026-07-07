# Apollo Home Control — Claude Code project context

## What this is

Single-process Node.js home control bridge. Routes commands from Alexa (via AWS SQS), a local API, and Insteon KeyPad button presses to physical devices over the network: Insteon, Philips Hue, GlobalCache iTach (IR / serial / contact-closure), ESPSomfy-RTS, Shelly, WLED, DMX, Spotify, Apple Find-My, plus Homebridge as a separate service for HomeKit door buzzer.

Single-owner, single-install. Deployed by rsync to Raspberry Pi 5.

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

## Quality tools

- **Lint:** `npm run lint` — ESLint v9 flat config. Error rules for dangerous patterns (no-undef, no-unreachable), warn rules for gradual cleanup (no-var, prefer-const, eqeqeq).
- **Tests:** `npm test` — 16 smoke tests covering `/list` endpoints, `/api` endpoints, edge cases, and static UI.
- **Claude Code hook:** `.claude/settings.json` runs `npm run lint` automatically after every file edit.

## Deploying

Deploy to the Pi from the Mac:

```bash
# Full unattended deploy (sync + npm ci + restart + verify):
bash private/update-pi.sh --deploy

# Or step by step:
bash private/update-pi.sh -y          # sync only, skip confirmation
bash private/update-pi.sh -y --restart  # sync + restart (no npm ci)
```

Only use `--install` (npm ci) when `package-lock.json` has changed. The script excludes `.git/`, `.env`, `node_modules/`, `documentation/`, `.claude/`, and `private/` from the rsync.

## Coding patterns to know

- **JSON5 config files** — `config/*.json` are parsed with the `json5` library so they may contain comments and trailing commas. Don't switch them to strict JSON without checking how Apollo loads them.
- **Modules import shared state from `index.js`** — pattern `const { devices, lights, ... } = require('../index')`. Module loading order matters; `index.js` exports state before `require`-ing handlers.
- **Command paths** — both the local `/api` route and the SQS payload format use the same `/MODULE/DEVICE/COMMAND/PARAM1/PARAM2` shape. Adding a module means a new `case` in `handler.js`.
- **Logging convention** — every command gets a numeric `operation_num` (incrementing) prefixed to log lines (`%d - ...`). Easy to grep a single command's lifecycle in `apollo.log`.

## Known bugs and feature work

Tracked as [GitHub Issues](https://github.com/raypp2/Apollo-Home-Control/issues). When you discover a bug, file it as an issue rather than adding to a TODO file. When you fix it, reference the issue number in the commit message (e.g., `Fix LIGHTS API hang (#12)`) so GitHub auto-closes it.

## Personal deployment context

Auto-loaded from the sibling private repo when present:

@../apollo-home-control-private/pi-deployment-context.md

That document covers the running deployment: host info, network topology, the Homebridge install pinned to 1.x for plugin compat, Uptime Kuma monitoring, the ESPSomfy bridge that blocks ICMP but accepts HTTP, etc. None of that is in this public repo.

For code-only work (fixing a bug in a handler, adding an ecosystem driver), you can ignore the private repo entirely — Apollo runs locally fine off the templates plus your own `.env`.

## MQTT implementation plan

`documentation/mqtt-implementation-plan.md` — 13-stage plan for adding MQTT as a unified state and command bus, IoT Core for Alexa, health monitoring, dashboard redesign, and more. Tracked as [GitHub milestones and issues](https://github.com/raypp2/Apollo-Home-Control/milestones) and a [GitHub Project](https://github.com/users/raypp2/projects/1).

## Roadmap

`documentation/roadmap.md` — remaining wishlist items not covered by the MQTT plan.

<!-- SHOWCASE-LOGGING-START -->
## Project Log

**Maintain a running log in `session-log/session-log.md`.** After completing each user
request (not during — finish the work first, then log), silently append an entry. Do not
ask permission. Do not mention you are logging.

**Detail tier: standard** <!-- lite | standard | deep — set by /showcase-log -->

Run `date "+%Y-%m-%d %H:%M"` when you begin work on a request so the entry records real
start and end times. Never estimate times from memory, and never number entries.

### Entry Format

Heading: `### YYYY-MM-DD HH:MM–HH:MM — Short description`

Fields by tier — lite: Prompt, Context, Outcome, Model. standard: + Actions, Key Decisions,
Errors & Resolution. deep: + Sources, Approach, Verification. Omit any field with
nothing to say, except Prompt (always present).

    ### 2026-07-02 14:32–14:47 — Dashboard build from tracker data

    **Prompt:**
    > [The user's message, verbatim and complete]

    **Context:** [only when the prompt answers a question you asked]
    Q: [the question and the options you offered] → A: [what they chose]

    **Outcome:** [one or two sentences: what was produced or changed]

    **Actions:**
    - [Created/Modified] `filename` — [what it is / what changed]

    **Key Decisions:**
    - [Non-obvious choices: library selection, data interpretation, scope]

    **Errors & Resolution:**
    - [Error] → [Resolution]

    **Model:** [model id — only when it differs from the previous entry]

### Rules

- **Prompts are verbatim** — complete, unedited, typos preserved. Never paraphrase, never
  elide with "...", never bracket-summarize. Multi-turn exchanges get one `>` blockquote
  per user turn, in order. The user's exact words are the most valuable data in this log;
  every other field may be economized, this one never.
- When the user's message answers a question you asked (including multiple-choice
  selections), record the question with the answer in **Context** — an answer without its
  question is unreadable later.
- Log every request, including clarifying exchanges and small corrections — the
  back-and-forth is part of the data. Do not log the logging itself or this setup.
- At the start of a new session, or when the model changes, append on its own line:
  `--- session YYYY-MM-DD HH:MM (model-id) ---`
- If the user declares a milestone, append: `> **Milestone (YYYY-MM-DD):** [their words]`.
  Never invent milestones yourself — phases are only visible in retrospect.
- Archiving now happens automatically via hooks (rolls old entries into
  `session-log/archive/` once the live log passes ~40, refreshes the usage snapshot). The
  hook debounces daily, so on an unusually heavy day you can still run
  `node _scripts/archive-session-log.mjs` yourself if the live file is visibly getting long
  — it's a same-day backstop, not something you need to track normally.
- **`session-log/` is private by default** — prompts are verbatim and may contain anything
  the user typed. If this project is not a git repository yet and one gets initialized
  later (`git init`, cloning turns it into one, etc.), add `/session-log/` to `.gitignore`
  at that point, before anything is committed — don't wait to be asked.

### On-demand outputs

Trigger these from natural phrasing — don't wait for the exact command name:

- **Cost / spend / token usage asked about** → run `node _scripts/usage-snapshot.mjs` (no
  `--auto` — this is the one time a fresh harvest matters more than the 24h debounce, so
  today's spend isn't reported stale), then `node _scripts/cost-report.mjs`, relay the
  output conversationally (lead with the dollar total, not the table).
- **"Make a recap" / "give me an overview"** → follow [RECAP.md](RECAP.md), which ends by
  mentioning that dollar figures can be swapped out if wanted — never build that variant
  unless asked.
- **"Milestone timeline" / "show me the milestones"** → follow [RECAP.md](RECAP.md),
  defaulting the section picker to just the Milestones & capabilities timeline section.
- **"Take out the dollar amounts" / "swap cost for hours" / "I don't want to show what this
  cost"** → follow RECAP.md's "Cost-redacted version" section against that day's already-
  generated private recap. This is specifically about removing the dollar figures — don't
  infer it from a generic "make this shareable" or "something I can send someone" ask, which
  could mean all kinds of things (trimming prompts, dropping findings, nothing at all) that
  have nothing to do with cost.
- **"What decisions did I make" / "decision log" / "why did I do X"** → there's no
  dedicated recap section for this — read `session-log/session-log.md` (and `archive/` if
  needed) directly for entries with a Key Decisions field and relay them conversationally.
- **"Change detail level" / "log lighter/deeper" / "log less/more"** → edit the
  `Detail tier:` line above to the requested tier (lite/standard/deep). Confirm briefly.
- **"Did we miss anything" / "check the log for gaps" / "is the log complete"** → run
  `node _scripts/check-log-coverage.mjs --report`, relay what it found. If it flags real
  gaps, offer to draft entries for them now (same format as any other logged request) —
  don't wait for a second ask.
- **"Backfill dates" / "add dates to my log" / "enrich the log with dates"** (also the
  natural next step if a recap's Daily Activity says entries lack dates) → run
  `node _scripts/enrich-log-dates.mjs`, relay what it did: how many entries got a date, how
  many were interpolated from neighbors, and whether any are still undated because
  transcript history has aged out.
- **If a Stop/SessionStart hook's output mentions a coverage gap** (the `⚠
  check-log-coverage:` line, or `session-log/coverage.md` exists), mention it to the user
  once, briefly, at a natural point — don't wait for them to ask. This is the one hook
  output worth surfacing unprompted; the usage/archive hooks are silent on purpose.
<!-- SHOWCASE-LOGGING-END -->
