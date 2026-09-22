import { app, BrowserWindow, shell, ipcMain, dialog, safeStorage } from 'electron'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const index = path.join(here, '..', 'dist', 'index.html')
let runtime
let mainWindow
if (process.env.AI_OLD_USER_DATA) app.setPath('userData', process.env.AI_OLD_USER_DATA)

function trusted(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame || event.senderFrame.url !== pathToFileURL(index).href) throw new Error('Untrusted desktop request')
}
function platformUrl(value) {
  const url = new URL(value)
  if (url.origin !== 'https://platform.deepseek.com' || url.username || url.password || !['/dsh/authorize', '/usage', '/top_up', '/api_keys'].includes(url.pathname)) throw new Error('Invalid DeepSeek page')
  return url.href
}
function reportStartupFailure() {
  dialog.showErrorBox('AI for the old 无法启动 / Unable to start', '本地界面加载失败。请重新启动应用；如果仍然失败，请重新安装与你的电脑匹配的版本。\nThe local interface failed to load. Restart or reinstall the matching installer.')
}
async function createWindow() {
  mainWindow = new BrowserWindow({ width: 1440, height: 980, minWidth: 980, minHeight: 700, backgroundColor: '#f5f7f6', webPreferences: { preload: path.join(here, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } })
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try { void shell.openExternal(platformUrl(url)) } catch { /* Reject unrelated destinations. */ }
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => { if (url !== pathToFileURL(index).href) event.preventDefault() })
  mainWindow.webContents.on('render-process-gone', reportStartupFailure)
  mainWindow.on('closed', () => { mainWindow = undefined })
  await mainWindow.loadFile(index)
}

if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', () => { if (mainWindow?.isMinimized()) mainWindow.restore(); mainWindow?.show(); mainWindow?.focus() })
  app.whenReady().then(async () => {
    process.env.AI_OLD_DATA_DIR ??= path.join(app.getPath('userData'), 'data')
    process.env.AI_OLD_WORKSPACE_ROOT ??= path.join(app.getPath('desktop'), 'AI for the old')
    process.env.AI_OLD_DESKTOP = '1'
    runtime = await import('../app/server/index.mjs')
    runtime.configureDesktop(safeStorage)
    await runtime.startServer(0)
    ipcMain.handle('local-api', (event, method, pathname, body) => { trusted(event); return runtime.dispatch(method, pathname, body) })
    ipcMain.handle('open-deepseek', (event, url) => { trusted(event); return shell.openExternal(platformUrl(url)) })
    await createWindow()
  }).catch(() => { reportStartupFailure(); app.quit() })
}
app.on('before-quit', () => runtime?.dispose())
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('activate', () => { if (runtime && BrowserWindow.getAllWindows().length === 0) createWindow().catch(reportStartupFailure) })
