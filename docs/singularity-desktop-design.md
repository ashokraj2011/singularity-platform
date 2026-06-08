# Singularity Desktop — laptop companion app (design)

Status: **draft / proposal**. Companion to the Connection Keys feature
(Operations → Connection Keys, PR #143) and the `singularity-mcp` CLI.

## 1. Why

Today, connecting a user's laptop to Context Fabric (so their workflow's tools
run **on their machine**) is a CLI step:

```
singularity-mcp login --email me@… --platform …   # or paste a Connection Key
singularity-mcp start --token <key>
```

That's fine for power users but:
- It's invisible — nothing shows *what the platform can do on my machine*.
- The device token sits in a `0600` JSON file (`~/.singularity-mcp/token.json`),
  not the OS keychain (the CLI itself flags this as a TODO: "M26.5 will swap
  this for the OS keychain").
- There's no local **consent surface**: a remote platform can run `git push`,
  write files, exec tools — and the user has no GUI to scope, see, or stop it.

A desktop app makes pairing one-click **and** turns the laptop into a proper,
consent-governed agent runner.

## 2. What it is

A small **Electron** tray app that **wraps the existing `mcp-server` laptop
runner** — it does not reimplement any protocol. It:

1. Pairs the laptop (paste a Connection Key, or log in → mint a device token).
2. Stores the token in the **OS keychain**.
3. Spawns/manages `mcp-server` in **laptop mode** (`LAPTOP_MODE=true`).
4. Shows **live connection status** and **recent tool invocations**.
5. Enforces **local consent**: allowed folders, scope toggles, per-action
   approval, and an always-visible kill switch.

The engine already exists; this is a **GUI shell + lifecycle + secure storage +
consent**.

## 3. What it reuses vs. builds

| Concern | Source | Status |
|---|---|---|
| Pair via key | `POST /auth/device-token` (IAM) | exists |
| Pair via login | `/auth/local/login` → `/auth/device-token` | exists (CLI does it) |
| Connect to bridge | `mcp-server` `LAPTOP_MODE` → `…/api/laptop-bridge/connect` | exists |
| Tool execution / approval pause | mcp-server + `mcp:resume` scope | exists |
| Token **scopes** | device JWT (`mcp:invoke`, `tools:execute`, `git:read/write`, `fs:read/write`) | exists |
| **OS-keychain token storage** | — | **build** (finish the CLI TODO) |
| **Config UI** (platform, bridge, device name, allowed paths, scopes) | — | **build** |
| **Lifecycle** (start/stop/restart, crash-respawn) | — | **build** |
| **Status + log stream** | — | **build** |
| **Tray + consent prompts** | — | **build** |

## 4. Architecture

```
┌─ Electron main process ─────────────────────────────────────┐
│  • token in OS keychain (safeStorage / keytar)              │
│  • spawns mcp-server child  (LAPTOP_MODE=true, env-injected)│
│  • lifecycle: start / stop / restart / crash-respawn        │
│  • system tray (status, quick connect/disconnect)           │
│  • IPC handlers (pair, start, stop, status, settings)       │
└───────────────┬─────────────────────────────────────────────┘
        IPC (contextBridge / preload)
┌───────────────▼─ renderer (UI) ────────────────────────────┐
│  Onboarding → Settings → Dashboard                          │
└─────────────────────────────────────────────────────────────┘
                │ ws  (laptop bridge)
                ▼
        Context Fabric  /api/laptop-bridge/connect
                │  (registers (user_id, device_id))
                ▼
        dispatch: run_context.user_id → this laptop
```

Notes:
- The runner is **Node**, so the app can spawn it as a child (clean isolation +
  restart). Later it can be bundled into the app package.
- One running child = one `(user_id, device_id)` registration.

## 5. Screens

1. **Onboarding** — two paths:
   - *Paste a Connection Key* (from Operations → Connection Keys), or
   - *Sign in* (email + password + platform URL) → app mints the device token.
   On success, the token is encrypted into the keychain.
2. **Settings** — platform URL, bridge URL, device name, **allowed folders**
   (picker), **scope toggles**, autostart-on-login.
3. **Dashboard** — connection dot (green/red), current capability, recent tool
   invocations (name, path, allow/deny), **Start / Stop / Disconnect**.
4. **Tray** — connection state + quick connect/disconnect; consent prompts
   ("Workflow X wants to run `git push` — Allow once / Always / Deny").

## 6. Security & consent model (the real reason for a desktop app)

A paired laptop lets a *remote platform run tools locally*. The app makes that
**explicit, local, and revocable**:

- **Allowed paths** — `fs:read` / `fs:write` ops are sandboxed to user-chosen
  folders. Nothing outside is reachable.
- **Scope toggles** — map 1:1 to the device-token scopes already enforced
  server-side; unchecking `git:write` mints/holds a token without it.
- **Per-action approval** — reuse the existing approval pause (`mcp:resume`):
  dangerous ops (push, write) prompt in the tray before running.
- **Keychain storage** — token never sits in plaintext on disk.
- **Kill switch** — Disconnect always visible; closing the app deregisters the
  laptop (falls back to the shared runner).
- **Token lifecycle** — show expiry; one-click re-mint / revoke (calls the same
  `DELETE /devices/:id` the web tab uses).

## 7. Packaging / distribution

- **electron-builder** → dmg (mac), nsis (win), AppImage/deb (linux).
- **mac**: code-sign + **notarize** (else Gatekeeper blocks); hardened runtime.
- **auto-update**: `electron-updater` against a release feed.
- **bundle** the `mcp-server` runner with the app (pinned version) so users
  don't install it separately.

## 8. Multi-user fit

Each user installs the app, pairs as themselves → their laptop registers under
*their* `user_id`. Runs they launch route to *their* laptop (per-user isolation
we already have). The app is the friendly front-end to the same `user_id` glue;
the `singularity-mcp` CLI remains for power users / CI.

> Reminder (from the multi-user analysis): the laptop registry is **in-memory
> per context-fabric process**. The desktop app doesn't change that — at scale,
> CF still needs single-instance-for-the-bridge or a shared/sticky registry.
> That's a server-side follow-up, independent of this client.

## 9. Phasing

- **P0 (scaffold, this PR):** Electron main + tray + Settings + spawn runner +
  keychain token + pair-by-key/login. Clickable, single-machine.
- **P1:** allowed-paths sandbox + scope toggles wired into mint.
- **P2:** per-action approval prompts in the tray (`mcp:resume`).
- **P3:** packaging (signing, notarize, auto-update) + bundled runner.
- **P4:** "LLM half" — optional local LLM bridge (the user's Copilot) as a
  second dispatch path, same device-key model. See
  [`deployment-topology.md`](./deployment-topology.md) §5 (the `model-run` frame)
  and §6 (placement policy / enterprise override).

## 10. Open questions

- Monorepo (`clients/singularity-desktop/`) or separate repo? (default: monorepo)
- Bundle the runner, or require `mcp-server` installed? (default: bundle in P3)
- Renderer stack: plain HTML (fast prototype) vs Vite+React (matches portal).
  P0 scaffold uses plain HTML to stay build-tool-free; can switch to React.
