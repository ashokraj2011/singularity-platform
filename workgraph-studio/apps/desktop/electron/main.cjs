const { app, BrowserWindow, ipcMain, Notification, shell } = require('electron')
const path = require('node:path')

const devServerUrl = process.env.VITE_DEV_SERVER_URL

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

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
