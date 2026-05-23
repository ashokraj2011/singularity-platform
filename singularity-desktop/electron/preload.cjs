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
  getConfig: () => ipcRenderer.invoke('desk:config:get'),
  setConfig: (patch) => ipcRenderer.invoke('desk:config:set', patch),
  pickRepoDirectory: () => ipcRenderer.invoke('desk:repo:pick-directory'),
  collectEvidence: (input) => ipcRenderer.invoke('desk:evidence:collect', input),
  startCopilot: (input) => ipcRenderer.invoke('desk:copilot:start', input),
  sendCopilotInput: (sessionId, data) => ipcRenderer.invoke('desk:copilot:stdin', { sessionId, data }),
  stopCopilot: (sessionId) => ipcRenderer.invoke('desk:copilot:stop', sessionId),
  onCopilotOutput: (handler) => {
    const listener = (_event, payload) => handler(payload)
    ipcRenderer.on('desk:copilot:output', listener)
    return () => ipcRenderer.removeListener('desk:copilot:output', listener)
  },
})
