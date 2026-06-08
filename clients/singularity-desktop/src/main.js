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
}

let win = null
let tray = null
let child = null
let shim = null
let runnerRegistered = false   // true once the runner logs "registered with bridge"
let quitting = false
const logs = []

// ── local LLM shim lifecycle ───────────────────────────────────────────────
function startShim(s) {
  if (shim) return
  shim = createShimServer({ copilotBase: s.copilotBaseUrl, defaultModel: s.localModel, log: pushLog })
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
  return {
    paired: !!token,
    running: !!child,
    registered: runnerRegistered,
    shimRunning: !!shim,
    user: claims ? { user_id: claims.sub, device_name: claims.device_name, exp: claims.exp } : null,
    settings: loadSettings(),
    logs: logs.slice(-80),
  }
}
function pushState() { if (win && !win.isDestroyed()) win.webContents.send('state', snapshot()) }

// ── runner lifecycle ───────────────────────────────────────────────────────────
function startRunner() {
  if (child) return { ok: true, already: true }
  const token = loadToken()
  if (!token) return { ok: false, error: 'not paired — pair a Connection Key or sign in first' }
  const s = loadSettings()
  if (!fs.existsSync(s.runnerEntry)) {
    return { ok: false, error: `runner not found at ${s.runnerEntry} — build it (cd mcp-server && npm run build) or set the path in Settings` }
  }
  const claims = decodeClaims(token) || {}
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1', // run the Electron binary as plain node
    LAPTOP_MODE: 'true',
    LAPTOP_BRIDGE_URL: s.bridge,
    SINGULARITY_DEVICE_TOKEN: token,
    SINGULARITY_DEVICE_ID: claims.device_id || '',
    SINGULARITY_DEVICE_NAME: claims.device_name || s.deviceName,
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
  const [copilotReachable, shimUp] = await Promise.all([
    copilotBase ? pingOk(`${copilotBase}/v1/models`) : Promise.resolve(false),
    shim ? pingOk(`http://localhost:${s.shimPort}/healthz`) : Promise.resolve(false),
  ])
  return {
    runnerRegistered,          // laptop accepted by the bridge (→ serving model-run)
    localLlmEnabled: !!s.localLlmEnabled,
    shimUp,                    // translation shim listening
    copilotReachable,          // Copilot bridge responding
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
  pushLog(`✓ paired as ${dt.email} (device ${dt.device_name})`)
  return { ok: true }
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
ipcMain.handle('pair:key', (_e, token) => { saveToken(String(token || '').trim()); pushLog('✓ paired with Connection Key'); return { ok: true } })
ipcMain.handle('pair:login', async (_e, creds) => { try { return await pairWithLogin(creds) } catch (err) { return { ok: false, error: String(err.message || err) } } })
ipcMain.handle('pair:clear', () => { stopRunner(); clearToken(); pushLog('▸ pairing cleared'); return { ok: true } })
ipcMain.handle('runner:start', () => startRunner())
ipcMain.handle('runner:stop', () => stopRunner())
ipcMain.handle('health:check', () => checkHealth())

app.whenReady().then(() => { createWindow(); createTray() })
app.on('activate', () => { if (win) win.show(); else createWindow() })
app.on('before-quit', () => { quitting = true; stopRunner() })
app.on('window-all-closed', () => { /* stay alive in tray */ })
