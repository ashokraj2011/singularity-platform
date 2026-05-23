const { app, BrowserWindow, dialog, ipcMain, Notification, shell } = require('electron')
const { execFile, spawn } = require('node:child_process')
const { mkdir, readFile, writeFile } = require('node:fs/promises')
const path = require('node:path')

const devServerUrl = process.env.VITE_DEV_SERVER_URL
const copilotCommand = process.env.COPILOT_CLI_BIN || 'copilot'
const copilotSessions = new Map()

function configPath() {
  return path.join(app.getPath('userData'), 'desk-config.json')
}

async function getConfig() {
  try {
    return JSON.parse(await readFile(configPath(), 'utf8'))
  } catch {
    return {}
  }
}

async function setConfig(patch) {
  const current = await getConfig()
  const next = { ...current, ...(patch && typeof patch === 'object' ? patch : {}) }
  await mkdir(path.dirname(configPath()), { recursive: true })
  await writeFile(configPath(), JSON.stringify(next, null, 2), 'utf8')
  return next
}

function execFileText(command, args, cwd) {
  return new Promise(resolve => {
    execFile(command, args, { cwd, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: String(stdout || ''), stderr: String(stderr || ''), error: error ? error.message : undefined })
    })
  })
}

async function collectEvidence(workdir, baseRef) {
  const cwd = typeof workdir === 'string' && workdir.trim() ? workdir.trim() : process.cwd()
  const diffArgs = baseRef ? ['diff', '--name-only', baseRef] : ['diff', '--name-only', 'HEAD']
  const [tracked, untracked, stat, patch] = await Promise.all([
    execFileText('git', diffArgs, cwd),
    execFileText('git', ['ls-files', '--others', '--exclude-standard'], cwd),
    execFileText('git', baseRef ? ['diff', '--stat', baseRef] : ['diff', '--stat', 'HEAD'], cwd),
    execFileText('git', baseRef ? ['diff', baseRef] : ['diff', 'HEAD'], cwd),
  ])
  const files = new Set()
  for (const source of [tracked.stdout, untracked.stdout]) {
    for (const line of source.split('\n')) {
      const trimmed = line.trim()
      if (trimmed) files.add(trimmed)
    }
  }
  const changedFiles = [...files].sort()
  const verificationReceipts = []
  const codeChanged = changedFiles.length > 0
  return {
    workdir: cwd,
    changedFiles,
    diffStat: stat.stdout.trim(),
    patchExcerpt: patch.stdout.slice(0, 24000),
    correlation: {
      codeChangeIds: changedFiles,
      verificationReceipts,
      verificationCoverage: {
        codeChanged,
        receiptsPresent: false,
        hasPassingReceipt: false,
        hasUnavailableReceipt: false,
        gap: codeChanged,
      },
      agentReasoningMode: 'direct-copilot',
    },
    warnings: [
      ...(tracked.ok ? [] : [`git diff failed: ${tracked.error ?? tracked.stderr}`]),
      ...(untracked.ok ? [] : [`git ls-files failed: ${untracked.error ?? untracked.stderr}`]),
    ],
  }
}

function detectCopilotCli() {
  return new Promise(resolve => {
    const child = spawn(copilotCommand, ['--version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    })
    let out = ''
    child.stdout.on('data', chunk => { out += String(chunk) })
    child.stderr.on('data', chunk => { out += String(chunk) })
    child.on('error', err => {
      resolve({
        available: false,
        command: copilotCommand,
        warning: `${copilotCommand} not found on PATH (${err.message})`,
      })
    })
    child.on('close', code => {
      if (code !== 0) {
        resolve({
          available: false,
          command: copilotCommand,
          warning: out.trim() || `${copilotCommand} --version exited with ${code}`,
        })
        return
      }
      const version = out.trim().match(/\d+\.\d+\.\d+/)?.[0] ?? out.trim()
      resolve({
        available: true,
        command: copilotCommand,
        version,
        warning: version && !/^1\.0\./.test(version)
          ? 'Copilot CLI version is outside the pinned 1.0.x compatibility range; session log format may differ.'
          : undefined,
      })
    })
  })
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 1024,
    minHeight: 700,
    title: 'Singularity Desk',
    backgroundColor: '#f6f8fb',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  win.once('ready-to-show', () => win.show())

  if (devServerUrl) {
    void win.loadURL(devServerUrl)
    win.webContents.openDevTools({ mode: 'detach' })
  } else {
    void win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  }
}

app.whenReady().then(() => {
  ipcMain.handle('desk:config:get', () => getConfig())
  ipcMain.handle('desk:config:set', (_event, patch) => setConfig(patch))

  ipcMain.handle('desk:repo:pick-directory', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Choose repository directory',
      properties: ['openDirectory'],
    })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('desk:open-external', async (_event, url) => {
    if (typeof url === 'string' && /^https?:\/\//.test(url)) {
      await shell.openExternal(url)
      return true
    }
    return false
  })

  ipcMain.handle('desk:notify', (_event, input) => {
    if (!Notification.isSupported()) return false
    const title = typeof input?.title === 'string' ? input.title : 'Singularity Desk'
    const body = typeof input?.body === 'string' ? input.body : ''
    new Notification({ title, body }).show()
    return true
  })

  ipcMain.handle('desk:detect-copilot-cli', () => detectCopilotCli())

  ipcMain.handle('desk:evidence:collect', (_event, input) => collectEvidence(input?.workdir, input?.baseRef))

  ipcMain.handle('desk:copilot:start', async (event, input) => {
    const sessionId = input?.sessionId || `${Date.now()}-${Math.random().toString(16).slice(2)}`
    const command = input?.command || copilotCommand
    const cwd = typeof input?.cwd === 'string' && input.cwd.trim() ? input.cwd.trim() : process.cwd()
    const args = Array.isArray(input?.args) ? input.args.map(String) : []
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...(input?.env && typeof input.env === 'object' ? input.env : {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    copilotSessions.set(sessionId, child)
    const send = (payload) => {
      if (!event.sender.isDestroyed()) event.sender.send('desk:copilot:output', { sessionId, ...payload })
    }
    child.stdout.on('data', chunk => send({ stream: 'stdout', data: String(chunk) }))
    child.stderr.on('data', chunk => send({ stream: 'stderr', data: String(chunk) }))
    child.on('error', err => send({ stream: 'system', data: `\n[copilot error] ${err.message}\n` }))
    child.on('close', code => {
      copilotSessions.delete(sessionId)
      send({ stream: 'system', data: `\n[copilot exited ${code ?? 0}]\n`, exitCode: code ?? 0 })
    })
    if (typeof input?.initialInput === 'string' && input.initialInput.trim()) {
      child.stdin.write(`${input.initialInput.trim()}\n`)
    }
    return { sessionId, pid: child.pid, cwd, command, args }
  })

  ipcMain.handle('desk:copilot:stdin', (_event, input) => {
    const child = copilotSessions.get(input?.sessionId)
    if (!child) return false
    child.stdin.write(String(input?.data ?? ''))
    return true
  })

  ipcMain.handle('desk:copilot:stop', (_event, sessionId) => {
    const child = copilotSessions.get(sessionId)
    if (!child) return false
    child.kill('SIGTERM')
    copilotSessions.delete(sessionId)
    return true
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
