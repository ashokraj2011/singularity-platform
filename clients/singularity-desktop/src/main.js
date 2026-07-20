'use strict'
// Singularity Desktop — Electron main process.
// Wraps the existing mcp-server laptop runner: pairs the laptop (key or login),
// stores the device token in the OS keychain (safeStorage), and spawns/manages
// mcp-server in LAPTOP_MODE. Prototype scaffold — see docs/singularity-desktop-design.md.
const { app, BrowserWindow, Tray, Menu, ipcMain, safeStorage, dialog, nativeImage } = require('electron')
const { spawn } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const { createShimServer } = require('./gateway-shim')

const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'settings.json')
const TOKEN_FILE = () => path.join(app.getPath('userData'), 'token.enc')
// Provider/git credentials entered in Settings — encrypted at rest (safeStorage)
// and injected into the runner + gateway at spawn. The app is the source of
// truth for these; .env files are only a fallback.
const SECRETS_FILE = () => path.join(app.getPath('userData'), 'secrets.enc')

const DEFAULTS = {
  platform: 'http://localhost:8100/api/v1',
  bridge: 'ws://localhost:8000/api/laptop-bridge/connect',
  deviceName: 'singularity-desktop',
  // best-guess path to the built runner inside this monorepo; override in Settings.
  runnerEntry: path.resolve(__dirname, '../../../mcp-server/dist/index.js'),
  allowedPaths: [],
  scopes: ['mcp:invoke', 'mcp:resume', 'tools:execute', 'fs:read'],
  // Local LLM (Copilot): when enabled, the app runs a translation shim and
  // points the runner's LLM_GATEWAY_URL at it, so model-run frames are served by
  // your local Copilot bridge. See docs/deployment-topology.md §5.
  localLlmEnabled: false,
  copilotBaseUrl: 'http://localhost:4141',
  localModel: 'gpt-4o',
  shimPort: 4319,
  // The app also starts the llm-gateway (uvicorn) from this monorepo checkout.
  repoRoot: path.resolve(__dirname, '../../..'),
  gatewayEnabled: true,
  copilotModel: 'claude-sonnet-4-6',
}

let win = null
let tray = null
let child = null
let shim = null
let gatewayChild = null   // the llm-gateway uvicorn the app now owns too
let runnerRegistered = false   // true once the runner logs "registered with bridge"
let quitting = false
const logs = []

// ── local LLM shim lifecycle ───────────────────────────────────────────────
function startShim(s) {
  if (shim) return
  const localModel = String(s.localModel || '').trim() || 'gpt-4o'
  shim = createShimServer({
    copilotBase: s.copilotBaseUrl,
    defaultModel: localModel,
    // The gateway catalog uses a provider-neutral `copilot` alias while the
    // local bridge needs the concrete model configured by the user. Concrete
    // aliases are also accepted by the shim and passed through unchanged.
    modelMap: { copilot: localModel, default: localModel, [localModel]: localModel },
    log: pushLog,
  })
  shim.on('error', (e) => { pushLog(`✗ local LLM shim error: ${e.message}`); shim = null })
  shim.listen(s.shimPort)
}
function stopShim() {
  if (shim) { try { shim.close() } catch { /* */ } shim = null }
}

// ── persistence ──────────────────────────────────────────────────────────────
function loadSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE(), 'utf8')) } }
  catch { return { ...DEFAULTS } }
}
function saveSettings(patch) {
  const merged = { ...loadSettings(), ...patch }
  fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(merged, null, 2))
  return merged
}
function saveToken(token) {
  const buf = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(token) : Buffer.from(token, 'utf8')
  fs.writeFileSync(TOKEN_FILE(), buf)
}
function loadToken() {
  try {
    const buf = fs.readFileSync(TOKEN_FILE())
    return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString('utf8')
  } catch { return null }
}
function clearToken() { try { fs.unlinkSync(TOKEN_FILE()) } catch { /* none */ } }

function loadSecrets() {
  try {
    const buf = fs.readFileSync(SECRETS_FILE())
    const raw = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString('utf8')
    return JSON.parse(raw)
  } catch { return {} }
}
function saveSecretsStore(patch) {
  const merged = { ...loadSecrets() }
  for (const [k, v] of Object.entries(patch || {})) {
    if (typeof v === 'string' && v.trim()) merged[k] = v.trim()
    else if (v === null || v === '') delete merged[k]
  }
  const raw = JSON.stringify(merged)
  const buf = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(raw) : Buffer.from(raw, 'utf8')
  fs.writeFileSync(SECRETS_FILE(), buf)
  return merged
}

function decodeClaims(token) {
  try { return JSON.parse(Buffer.from(token.split('.')[1] || '', 'base64url').toString('utf8')) }
  catch { return null }
}

// ── state + logs ──────────────────────────────────────────────────────────────
function pushLog(line) {
  logs.push(line); if (logs.length > 300) logs.shift()
  if (win && !win.isDestroyed()) win.webContents.send('log', line)
}
function snapshot() {
  const token = loadToken()
  const claims = token ? decodeClaims(token) : null
  const sec = loadSecrets()
  return {
    paired: !!token,
    running: !!child,
    registered: runnerRegistered,
    shimRunning: !!shim,
    gatewayRunning: !!gatewayChild,
    secrets: {
      anthropicKeySet: !!sec.anthropicKey,
      anthropicKeyHint: sec.anthropicKey ? sec.anthropicKey.slice(-4) : '',
      githubTokenSet: !!sec.githubToken,
    },
    user: claims ? { user_id: claims.sub, device_name: claims.device_name, exp: claims.exp } : null,
    settings: loadSettings(),
    logs: logs.slice(-80),
  }
}
function pushState() { if (win && !win.isDestroyed()) win.webContents.send('state', snapshot()) }

// ── laptop env files (.env.laptop / .env.llm-secrets at the repo root) ───────
// The app loads these ITSELF at spawn time, so it no longer matters which shell
// launched Electron — no more `set -a; source .env.laptop` dance.
function parseEnvFile(file) {
  try {
    const out = {}
    for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
      const line = raw.trim()
      if (!line || line.startsWith('#')) continue
      const i = line.indexOf('=')
      if (i <= 0) continue
      const k = line.slice(0, i).trim()
      let v = line.slice(i + 1).trim()
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
      out[k] = v
    }
    return out
  } catch { return {} }
}
function laptopFileEnv(s) {
  const root = s.repoRoot || DEFAULTS.repoRoot
  return { ...parseEnvFile(path.join(root, '.env.llm-secrets')), ...parseEnvFile(path.join(root, '.env.laptop')) }
}

// ── llm-gateway lifecycle (the app owns the laptop's LLM side too) ───────────
async function startGateway(s, fileEnv, sec) {
  if (gatewayChild) return { ok: true, already: true }
  if (await pingOk('http://localhost:8001/health')) {
    pushLog('▸ llm-gateway already running on :8001 — reusing it')
    return { ok: true, external: true }
  }
  const root = s.repoRoot || DEFAULTS.repoRoot
  const venvPy = path.join(root, 'context-fabric', '.venv', 'bin', 'python')
  const py = fs.existsSync(venvPy) ? venvPy : 'python3'
  // Fresh clone: the live provider/model configs are gitignored — restore them
  // from the tracked .default templates so the gateway can boot.
  for (const f of ['llm-providers.json', 'llm-models.json']) {
    const live = path.join(root, '.singularity', f)
    try { if (!fs.existsSync(live) && fs.existsSync(`${live}.default`)) fs.copyFileSync(`${live}.default`, live) } catch { /* best-effort */ }
  }
  const env = {
    ...process.env,
    ...fileEnv,
    // App-stored credentials win — the gateway's anthropic provider uses the
    // same key the Copilot stages use.
    ...(sec?.anthropicKey ? { ANTHROPIC_API_KEY: sec.anthropicKey } : {}),
    PYTHONUNBUFFERED: '1',
    LLM_PROVIDER_CONFIG_PATH: path.join(root, '.singularity', 'llm-providers.json'),
    LLM_MODEL_CATALOG_PATH: path.join(root, '.singularity', 'llm-models.json'),
    ALLOW_CALLER_PROVIDER_OVERRIDE: 'false',
  }
  gatewayChild = spawn(py, ['-m', 'uvicorn', 'services.llm_gateway_service.app.main:app', '--host', '0.0.0.0', '--port', '8001'], {
    cwd: path.join(root, 'context-fabric'), env,
  })
  pushLog(`▸ llm-gateway starting (pid ${gatewayChild.pid}) on :8001 (${py === venvPy ? '.venv python' : 'system python3'})`)
  const onGw = (d) => String(d).split('\n').map((l) => l.trimEnd()).filter(Boolean).forEach((l) => pushLog(`[gateway] ${l}`))
  gatewayChild.stdout.on('data', onGw)
  gatewayChild.stderr.on('data', onGw)
  gatewayChild.on('exit', (code) => { pushLog(`✗ llm-gateway exited (code ${code})`); gatewayChild = null; pushState() })
  return { ok: true }
}
function stopGateway() {
  if (gatewayChild) { try { gatewayChild.kill() } catch { /* */ } gatewayChild = null; pushLog('▸ llm-gateway stopped') }
}

// ── runner lifecycle ───────────────────────────────────────────────────────────
async function startRunner() {
  if (child) return { ok: true, already: true }
  const token = loadToken()
  if (!token) return { ok: false, error: 'not paired — pair a Connection Key or sign in first' }
  const s = loadSettings()
  if (!fs.existsSync(s.runnerEntry)) {
    return { ok: false, error: `runner not found at ${s.runnerEntry} — build it (cd mcp-server && npm run build) or set the path in Settings` }
  }
  // Secrets/config: app-stored credentials (keychain) are the source of truth;
  // the repo's .env files are only a fallback.
  const fileEnv = laptopFileEnv(s)
  const sec = loadSecrets()
  // One button = the whole laptop side: bring the llm-gateway up first (unless
  // the local-Copilot shim replaces it below).
  if (!s.localLlmEnabled && s.gatewayEnabled !== false) await startGateway(s, fileEnv, sec)
  const claims = decodeClaims(token) || {}
  // The runner's required env beyond the bridge vars. Shell/.env values win;
  // defaults match the local deployment (gateway :8001, dev bearer, process
  // execution, ~/sg-laptop-workspace sandbox) so the app works out of the box.
  const sandboxRoot = process.env.MCP_SANDBOX_ROOT || path.join(app.getPath('home'), 'sg-laptop-workspace')
  try { fs.mkdirSync(sandboxRoot, { recursive: true }) } catch { /* best-effort */ }
  const env = {
    ...process.env,
    ...fileEnv,
    ELECTRON_RUN_AS_NODE: '1', // run the Electron binary as plain node
    LAPTOP_MODE: 'true',
    LAPTOP_BRIDGE_URL: s.bridge,
    SINGULARITY_DEVICE_TOKEN: token,
    SINGULARITY_DEVICE_ID: claims.device_id || '',
    SINGULARITY_DEVICE_NAME: claims.device_name || s.deviceName,
    MCP_BEARER_TOKEN: process.env.MCP_BEARER_TOKEN || fileEnv.MCP_BEARER_TOKEN || 'demo-bearer-token-must-be-min-16-chars',
    LLM_GATEWAY_URL: process.env.LLM_GATEWAY_URL || fileEnv.LLM_GATEWAY_URL || 'http://localhost:8001',
    MCP_COMMAND_EXECUTION_MODE: process.env.MCP_COMMAND_EXECUTION_MODE || fileEnv.MCP_COMMAND_EXECUTION_MODE || 'process',
    MCP_SANDBOX_ROOT: sandboxRoot,
    // ── credentials from Settings → Credentials (keychain) — these WIN ──────
    ...(sec.anthropicKey ? {
      COPILOT_PROVIDER_TYPE: 'anthropic',
      COPILOT_PROVIDER_BASE_URL: 'https://api.anthropic.com',
      COPILOT_PROVIDER_API_KEY: sec.anthropicKey,
    } : {}),
    ...(s.copilotModel ? { COPILOT_MODEL: s.copilotModel } : {}),
    ...(sec.githubToken ? {
      GITHUB_TOKEN: sec.githubToken,
      MCP_GIT_PUSH_ENABLED: 'true',
      MCP_GIT_AUTH_MODE: 'token',
    } : {}),
  }
  // Local LLM (Copilot): run the translation shim and serve model-run frames
  // from it by pointing the runner's LLM_GATEWAY_URL at the shim.
  if (s.localLlmEnabled) {
    try {
      startShim(s)
      env.LLM_GATEWAY_URL = `http://localhost:${s.shimPort}`
      pushLog(`▸ local LLM shim on :${s.shimPort} → ${s.copilotBaseUrl} (model ${s.localModel})`)
    } catch (e) {
      pushLog(`✗ local LLM shim failed to start: ${e.message}`)
    }
  }
  // Loud preflight for the classic copilot-stage failure: a missing/placeholder
  // provider key only surfaces later as an Anthropic 401 inside a run.
  const ck = env.COPILOT_PROVIDER_API_KEY || ''
  if (env.COPILOT_PROVIDER_TYPE === 'anthropic' && (!ck || ck.includes('REPLACE_ME'))) {
    pushLog('⚠ Anthropic key missing/placeholder — copilot stages will fail 401. Set it in Settings → Credentials.')
  }
  if ((env.GITHUB_TOKEN || '').includes('REPLACE_ME')) {
    pushLog('⚠ GitHub token is still a placeholder — the GIT_PUSH stage will fail. Set it in Settings → Credentials.')
  }
  child = spawn(process.execPath, [s.runnerEntry], { env })
  pushLog(`▸ runner started (pid ${child.pid}) → ${s.bridge}`)
  const onData = (d) => String(d).split('\n').map((l) => l.trimEnd()).filter(Boolean).forEach((line) => {
    // The relay-client logs this on auth.ack — i.e. the bridge accepted us and
    // we're now registered (and advertising model-run).
    if (line.includes('registered with bridge')) { runnerRegistered = true; pushState() }
    else if (line.includes('requested disconnect') || line.includes('laptop disconnected')) { runnerRegistered = false; pushState() }
    pushLog(line)
  })
  child.stdout.on('data', onData)
  child.stderr.on('data', onData)
  child.on('exit', (code) => { pushLog(`✗ runner exited (code ${code})`); child = null; runnerRegistered = false; updateTray(); pushState() })
  updateTray(); pushState()
  return { ok: true }
}
function stopRunner() {
  if (child) { try { child.kill() } catch { /* */ } child = null; pushLog('▸ runner stopped') }
  runnerRegistered = false
  stopShim()
  stopGateway()
  updateTray(); pushState()
  return { ok: true }
}

// ── health checks (preflight: is the path actually live?) ──────────────────
async function pingOk(url, opts = {}) {
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 2500)
    const r = await fetch(url, { signal: ctrl.signal, ...opts })
    clearTimeout(t)
    return r.status < 500   // any non-5xx means it's listening
  } catch { return false }
}

async function checkHealth() {
  const s = loadSettings()
  const copilotBase = (s.copilotBaseUrl || '').replace(/\/$/, '')
  const [copilotReachable, shimUp, gatewayUp] = await Promise.all([
    copilotBase ? pingOk(`${copilotBase}/v1/models`) : Promise.resolve(false),
    shim ? pingOk(`http://localhost:${s.shimPort}/healthz`) : Promise.resolve(false),
    pingOk('http://localhost:8001/health'),
  ])
  return {
    runnerRegistered,          // laptop accepted by the bridge (→ serving model-run)
    localLlmEnabled: !!s.localLlmEnabled,
    shimUp,                    // translation shim listening
    copilotReachable,          // Copilot bridge responding
    gatewayUp,                 // llm-gateway answering on :8001 (app-owned or external)
  }
}

// ── pairing ────────────────────────────────────────────────────────────────────
async function pairWithLogin({ email, password, platform }) {
  const base = (platform || loadSettings().platform).replace(/\/$/, '')
  const r1 = await fetch(`${base}/auth/local/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  if (!r1.ok) throw new Error(`login failed: ${r1.status}`)
  const login = await r1.json()
  const r2 = await fetch(`${base}/auth/device-token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${login.access_token}` },
    body: JSON.stringify({ device_name: loadSettings().deviceName, ttl_days: 90, scopes: [] }),
  })
  if (!r2.ok) throw new Error(`device-token failed: ${r2.status}`)
  const dt = await r2.json()
  saveToken(dt.access_token)
  pushLog(`✓ Connection Key generated for ${dt.email} (device ${dt.device_name}) — stored in keychain`)
  // Generate → connect is ONE motion: start the runner immediately so the
  // laptop registers with Context Fabric without a separate click.
  const started = await startRunner()
  pushLog(started.ok ? '▸ connecting to the bridge…' : `⚠ runner not started: ${started.error}`)
  // Return the key so the UI can reveal it once (PAT-style) for CLI/other-device use.
  return { ok: true, key: dt.access_token, email: dt.email, device: dt.device_name, runner: started }
}

// ── tray + window ────────────────────────────────────────────────────────────
function updateTray() {
  if (!tray) return
  try {
    tray.setTitle(child ? ' ●' : ' ○') // mac menu-bar text indicator
    tray.setToolTip(child ? 'Singularity: connected' : 'Singularity: idle')
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: child ? 'Stop runner' : 'Start runner', click: () => (child ? stopRunner() : startRunner()) },
      { label: 'Open', click: () => { if (win) win.show() } },
      { type: 'separator' },
      { label: 'Quit', click: () => { quitting = true; stopRunner(); app.quit() } },
    ]))
  } catch { /* tray best-effort */ }
}
function createTray() {
  try {
    tray = new Tray(nativeImage.createEmpty())
    updateTray()
  } catch { tray = null }
}
function createWindow() {
  win = new BrowserWindow({
    width: 760, height: 620, title: 'Singularity Desktop',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  })
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'))
  win.on('close', (e) => { if (!quitting) { e.preventDefault(); win.hide() } })
  win.webContents.on('did-finish-load', pushState)
}

// ── IPC ────────────────────────────────────────────────────────────────────────
ipcMain.handle('state:get', () => snapshot())
ipcMain.handle('settings:save', (_e, patch) => saveSettings(patch || {}))
ipcMain.handle('settings:pick-folder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'multiSelections'] })
  return r.canceled ? [] : r.filePaths
})
ipcMain.handle('pair:key', async (_e, token) => {
  // Validate BEFORE storing so a bad paste fails here, not later as a silent
  // bridge 4401. Then connect immediately — pairing IS establishing the link.
  const t = String(token || '').trim()
  const claims = decodeClaims(t)
  if (!claims || claims.kind !== 'device' || !claims.sub || !claims.device_id) {
    return { ok: false, error: 'not a device Connection Key (generate one in Operations → Connection Keys, or use Sign in)' }
  }
  if (typeof claims.exp === 'number' && Date.now() / 1000 > claims.exp) {
    return { ok: false, error: 'this Connection Key is expired — generate a new one' }
  }
  saveToken(t)
  pushLog(`✓ paired with Connection Key (user ${claims.sub})`)
  const started = await startRunner()
  pushLog(started.ok ? '▸ connecting to the bridge…' : `⚠ runner not started: ${started.error}`)
  return { ok: true, runner: started }
})
ipcMain.handle('pair:login', async (_e, creds) => { try { return await pairWithLogin(creds) } catch (err) { return { ok: false, error: String(err.message || err) } } })
ipcMain.handle('pair:clear', () => { stopRunner(); clearToken(); pushLog('▸ pairing cleared'); return { ok: true } })
ipcMain.handle('secrets:save', async (_e, patch) => {
  saveSecretsStore(patch)
  // Apply immediately: a saved key that only takes effect on the NEXT manual
  // restart kept surfacing as a mid-run Anthropic 401. Restart the children.
  if (child) {
    pushLog('✓ credentials updated — restarting runner + gateway to apply them')
    stopRunner()
    const started = await startRunner()
    if (!started.ok) pushLog(`⚠ runner restart failed: ${started.error}`)
  } else {
    pushLog('✓ credentials updated (stored encrypted)')
  }
  pushState()
  return { ok: true }
})
ipcMain.handle('runner:start', () => startRunner())
ipcMain.handle('runner:stop', () => stopRunner())
ipcMain.handle('health:check', () => checkHealth())

app.whenReady().then(() => { createWindow(); createTray() })
app.on('activate', () => { if (win) win.show(); else createWindow() })
app.on('before-quit', () => { quitting = true; stopRunner() })
app.on('window-all-closed', () => { /* stay alive in tray */ })
