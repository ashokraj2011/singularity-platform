const { app, BrowserWindow, ipcMain, Notification, shell } = require('electron')
const { spawn } = require('node:child_process')
const path = require('node:path')

const devServerUrl = process.env.VITE_DEV_SERVER_URL
const copilotCommand = process.env.COPILOT_CLI_BIN || 'copilot'

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

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
