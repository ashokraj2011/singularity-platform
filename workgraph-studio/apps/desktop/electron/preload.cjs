const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('singularityDesk', {
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
  openExternal: (url) => ipcRenderer.invoke('desk:open-external', url),
  notify: (input) => ipcRenderer.invoke('desk:notify', input),
  detectCopilotCli: () => ipcRenderer.invoke('desk:detect-copilot-cli'),
})
