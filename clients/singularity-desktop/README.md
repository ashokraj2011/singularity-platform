# Singularity Desktop (prototype scaffold)

A small Electron tray app that pairs your laptop to **Context Fabric** and runs
the existing **`mcp-server`** in laptop mode — so workflows you launch can run
tools **on your machine**. GUI alternative to the `singularity-mcp` CLI.

> Status: **P0 scaffold** (clickable, single-machine). Design + roadmap:
> [`docs/singularity-desktop-design.md`](../../docs/singularity-desktop-design.md).
> Not yet signed/notarized or packaged.

## What it does
- **Pair** — paste a Connection Key (Operations → Connection Keys) **or** sign in
  (email + password) → mints a device token.
- **Stores the token in the OS keychain** (Electron `safeStorage`).
- **Start/Stop the runner** — spawns `mcp-server` with `LAPTOP_MODE=true` +
  `SINGULARITY_DEVICE_TOKEN`, connecting to the laptop bridge.
- **Dashboard** — connection status + live runner log; **tray** quick toggle.
- **Settings** — platform/bridge URL, device name, runner path, allowed folders,
  scope toggles. *(Allowed-paths sandbox + scope-gated mint land in P1.)*
- **Local LLM (Copilot)** — toggle "Run LLM on this laptop via Copilot": the app
  runs a translation **shim** (`src/gateway-shim.js`) that converts the
  platform's gateway request to your Copilot bridge's OpenAI shape and back, then
  points the runner's `LLM_GATEWAY_URL` at it. Start the bridge first
  (`npx copilot-api@latest start --port 4141`). Now LLM-on-laptop is one click —
  no separate `llm-gateway` to run. Translation is unit-tested: `npm test`.

## Run it
```bash
# 1) build the runner it wraps
cd ../../mcp-server && npm run build && cd -

# 2) install + start the app
cd clients/singularity-desktop
npm install
npm start
```
Then: **Pair** (paste a key or sign in as e.g. `user1@singularity.local` /
`Admin1234!`) → **Dashboard → Start runner**. The menu-bar dot shows status.

## How it connects (no new protocol)
```
pair → device token (sub = your user_id), stored in keychain
Start → spawn mcp-server (LAPTOP_MODE) → ws → /api/laptop-bridge/connect
context-fabric registers (user_id, device_id); your runs route to this laptop
```

## Defaults (override in Settings)
| Setting | Default |
|---|---|
| Platform (IAM) | `http://localhost:8100/api/v1` |
| Bridge | `ws://localhost:8000/api/laptop-bridge/connect` |
| Runner entry | `../../mcp-server/dist/index.js` |

## Not done yet (see design doc)
P1 allowed-paths sandbox + scope-gated mint · P2 per-action approval prompts ·
P3 packaging (sign/notarize/auto-update + bundled runner) · P4 optional local LLM bridge.
