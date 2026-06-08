'use strict'
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  getState: () => ipcRenderer.invoke('state:get'),
  saveSettings: (s) => ipcRenderer.invoke('settings:save', s),
  pickFolder: () => ipcRenderer.invoke('settings:pick-folder'),
  pairWithKey: (token) => ipcRenderer.invoke('pair:key', token),
  pairWithLogin: (creds) => ipcRenderer.invoke('pair:login', creds),
  clearPairing: () => ipcRenderer.invoke('pair:clear'),
  startRunner: () => ipcRenderer.invoke('runner:start'),
  stopRunner: () => ipcRenderer.invoke('runner:stop'),
  onLog: (cb) => ipcRenderer.on('log', (_e, line) => cb(line)),
  onState: (cb) => ipcRenderer.on('state', (_e, st) => cb(st)),
})
