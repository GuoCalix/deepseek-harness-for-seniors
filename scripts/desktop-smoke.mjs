import { _electron as electron } from '@playwright/test'
import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import assert from 'node:assert/strict'

const directory = await mkdtemp(path.join(os.tmpdir(), 'ai-old-desktop-smoke-'))
const executablePath = process.env.AI_OLD_TEST_EXECUTABLE
const testEnvironment = { ...process.env, DEEPSEEK_API_KEY: '', DEEPSEEK_PLATFORM_ORIGIN: 'https://platform.deepseek.com', DEEPSEEK_INFERENCE_ORIGIN: 'https://api.deepseek.com', AI_OLD_USER_DATA: path.join(directory, 'user-data'), AI_OLD_DATA_DIR: path.join(directory, 'data'), AI_OLD_WORKSPACE_ROOT: path.join(directory, 'workspace'), AI_OLD_ALLOW_MOCK: 'true' }
delete testEnvironment.ELECTRON_RUN_AS_NODE
const application = await electron.launch({
  ...(executablePath ? { executablePath: path.resolve(executablePath), args: [] } : { args: ['.'] }),
  env: testEnvironment,
  timeout: 30_000,
})
try {
  const page = await application.firstWindow()
  page.setDefaultTimeout(20_000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.getByRole('heading', { name: '把要做的事告诉我，我来帮你完成。' }).waitFor()
  const loaded = await page.evaluate(() => ({ scripts: [...document.scripts].filter(s => s.src).every(s => s.src.startsWith('file:')), bridge: typeof window.desktop?.request === 'function' }))
  assert.equal(loaded.scripts, true)
  assert.equal(loaded.bridge, true)
  const encryption = process.env.AI_OLD_SKIP_KEYCHAIN_TEST === 'true' ? null : await Promise.race([application.evaluate(async ({ safeStorage }) => {
    if (!await safeStorage.isAsyncEncryptionAvailable()) return { available: false }
    const value = 'non-secret-storage-test'
    const encrypted = await safeStorage.encryptStringAsync(value)
    return { available: true, roundTrip: (await safeStorage.decryptStringAsync(encrypted)).result === value, hidden: !encrypted.includes(Buffer.from(value)) }
  }), new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('System keychain is waiting for user unlock/approval')), 15_000); timer.unref() })])
  if (encryption) assert.deepEqual(encryption, { available: true, roundTrip: true, hidden: true })
  await page.getByPlaceholder('你想让电脑帮你做什么？').fill('帮我整理桌面的照片')
  await page.getByRole('button', { name: '开始整理' }).click()
  await page.getByRole('button', { name: /按日期整理照片/ }).waitFor()
  const count = await page.locator('.candidate-card').count()
  assert.equal(count, 3)
  await page.getByRole('button', { name: /按日期整理照片/ }).click()
  await page.getByRole('button', { name: '继续', exact: true }).click()
  await page.getByText('执行前看一眼').waitFor()
  await page.getByRole('button', { name: '账户与充值', exact: true }).click()
  await page.getByRole('heading', { name: '账户与充值' }).waitFor()
  await page.getByRole('button', { name: '管理连接' }).click()
  await page.getByRole('button', { name: '打开官方账号授权' }).waitFor()
  assert.deepEqual(errors, [])
  const root = process.env.AI_OLD_SCREENSHOT_DIR
  if (root) { await mkdir(root, { recursive: true }); await page.screenshot({ path: path.join(root, 'desktop-login.png') }) }
  console.log(JSON.stringify({ packaged: Boolean(executablePath), rendered: true, ipcPost: true, secureStorage: encryption ? 'passed' : 'skipped-explicitly', candidates: count, clarification: true, login: true, rendererErrors: errors.length }))
} finally {
  const terminate = setTimeout(() => application.process().kill('SIGKILL'), 5000)
  try { await application.close() } catch { /* A locked keychain can delay process shutdown. */ }
  clearTimeout(terminate)
  await rm(directory, { recursive: true, force: true })
}
