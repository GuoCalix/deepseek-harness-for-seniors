const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('desktop', Object.freeze({
  request: (method, pathname, body) => ipcRenderer.invoke('local-api', method, pathname, body),
  openDeepSeek: url => ipcRenderer.invoke('open-deepseek', url),
  openPath: value => ipcRenderer.invoke('open-local-path', value),
}))
