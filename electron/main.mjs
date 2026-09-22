import { app, BrowserWindow, shell } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
let localServer

async function createWindow() {
  const userData = app.getPath('userData')
  process.env.AI_OLD_DATA_DIR ??= path.join(userData, 'data')
  process.env.AI_OLD_WORKSPACE_ROOT ??= path.join(app.getPath('desktop'), 'AI for the old')

  const serverModule = await import(path.join(here, '..', 'app', 'server', 'index.mjs'))
  localServer = serverModule.httpServer
  if (!localServer.listening) await new Promise(resolve => localServer.once('listening', resolve))

  const window = new BrowserWindow({
    width: 1440,
    height: 980,
    minWidth: 980,
    minHeight: 700,
    backgroundColor: '#f5f7f6',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://platform.deepseek.com/')) shell.openExternal(url)
    return { action: 'deny' }
  })
  await window.loadFile(path.join(here, '..', 'dist', 'index.html'))
}

app.whenReady().then(createWindow).catch(error => {
  console.error('Unable to start desktop app:', error)
  app.quit()
})

app.on('before-quit', () => {
  localServer?.close()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
