'use strict'
// Singularity Desktop — Electron main process.
// Wraps the existing mcp-server laptop runner: pairs the laptop (key or login),
// stores the device token in the OS keychain (safeStorage), and spawns/manages
// mcp-server in LAPTOP_MODE. Prototype scaffold — see docs/singularity-desktop-design.md.
const { app, BrowserWindow, Tray, Menu, ipcMain, safeStorage, dialog, nativeImage } = require('electron')
const { spawn } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')

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
}

let win = null
let tray = null
let child = null
let quitting = false
const logs = []

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
  child = spawn(process.execPath, [s.runnerEntry], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1', // run the Electron binary as plain node
      LAPTOP_MODE: 'true',
      LAPTOP_BRIDGE_URL: s.bridge,
      SINGULARITY_DEVICE_TOKEN: token,
      SINGULARITY_DEVICE_ID: claims.device_id || '',
      SINGULARITY_DEVICE_NAME: claims.device_name || s.deviceName,
    },
  })
  pushLog(`▸ runner started (pid ${child.pid}) → ${s.bridge}`)
  const onData = (d) => String(d).split('\n').map((l) => l.trimEnd()).filter(Boolean).forEach(pushLog)
  child.stdout.on('data', onData)
  child.stderr.on('data', onData)
  child.on('exit', (code) => { pushLog(`✗ runner exited (code ${code})`); child = null; updateTray(); pushState() })
  updateTray(); pushState()
  return { ok: true }
}
function stopRunner() {
  if (child) { try { child.kill() } catch { /* */ } child = null; pushLog('▸ runner stopped'); updateTray(); pushState() }
  return { ok: true }
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

app.whenReady().then(() => { createWindow(); createTray() })
app.on('activate', () => { if (win) win.show(); else createWindow() })
app.on('before-quit', () => { quitting = true; stopRunner() })
app.on('window-all-closed', () => { /* stay alive in tray */ })
