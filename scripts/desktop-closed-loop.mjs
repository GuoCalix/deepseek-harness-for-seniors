import { _electron as electron } from '@playwright/test'
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import assert from 'node:assert/strict'

const directory = await mkdtemp(path.join(os.tmpdir(), 'ai-old-closed-loop-'))
const desktop = path.join(directory, 'Desktop')
const downloads = path.join(directory, 'Downloads')
const workspace = path.join(directory, 'workspace')
const trash = path.join(directory, 'Trash')
await Promise.all([mkdir(desktop), mkdir(downloads), mkdir(workspace), mkdir(trash)])
const installers = [path.join(desktop, 'MyApp-4.2.dmg'), path.join(desktop, 'AnotherTool.dmg')]
await Promise.all(installers.map(file => writeFile(file, 'closed-loop-fixture')))

const environment = { ...process.env, DEEPSEEK_API_KEY: '', AI_OLD_ALLOW_MOCK: 'true', AI_OLD_SKIP_KEYCHAIN_TEST: 'true', AI_OLD_USER_DATA: path.join(directory, 'user-data'), AI_OLD_DATA_DIR: path.join(directory, 'data'), AI_OLD_DESKTOP_PATH: desktop, AI_OLD_DOWNLOADS_PATH: downloads, AI_OLD_WORKSPACE_ROOT: workspace, AI_OLD_TRASH_ROOT: trash }
delete environment.ELECTRON_RUN_AS_NODE
const executablePath = process.env.AI_OLD_TEST_EXECUTABLE
const application = await electron.launch({ ...(executablePath ? { executablePath: path.resolve(executablePath), args: [] } : { args: ['.'] }), env: environment, timeout: 30_000 })
try {
  const page = await application.firstWindow()
  page.setDefaultTimeout(20_000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.getByRole('heading', { name: '把要做的事告诉我，我来帮你完成。' }).waitFor()
  await page.getByPlaceholder('你想让电脑帮你做什么？').fill('删除桌面上的安装包')
  await page.getByRole('button', { name: '开始整理' }).click()
  await page.getByRole('button', { name: /整理相关文件/ }).waitFor()
  await page.getByRole('button', { name: /整理相关文件/ }).click()
  await page.getByRole('button', { name: '继续', exact: true }).click()
  await page.getByText('执行前看一眼').waitFor()
  await page.getByRole('button', { name: '确认并开始' }).click()
  await page.getByText('已经完成').waitFor()
  for (const installer of installers) await assert.rejects(access(installer))
  const trashEntries = await readdir(trash)
  assert.equal(trashEntries.filter(name => name.endsWith('.dmg')).length, installers.length)
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ closedLoop: 'passed', tool: 'move_to_trash', filesMoved: installers.length, rendererErrors: errors.length }))
} finally {
  const terminate = setTimeout(() => application.process().kill('SIGKILL'), 5_000)
  try { await application.close() } catch { /* best effort */ }
  clearTimeout(terminate)
  await rm(directory, { recursive: true, force: true })
}
