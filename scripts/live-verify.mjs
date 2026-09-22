// Explicit, opt-in live verification. Read the test key from stdin; never print it.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import assert from 'node:assert/strict'
import { createInterface } from 'node:readline'

const input = createInterface({ input: process.stdin, terminal: false })
console.log('Waiting for a low-budget test API key on stdin (not logged).')
const key = await new Promise(resolve => input.once('line', resolve))
input.close()
const directory = await mkdtemp(path.join(os.tmpdir(), 'ai-old-live-check-'))
process.env.AI_OLD_DATA_DIR = directory
process.env.AI_OLD_WORKSPACE_ROOT = path.join(directory, 'workspace')
process.env.AI_OLD_DESKTOP = '1'
delete process.env.AI_OLD_ALLOW_MOCK
delete process.env.DEEPSEEK_API_KEY
const runtime = await import('../app/server/index.mjs')
async function request(method, url, data = {}) {
  const response = await runtime.dispatch(method, url, method === 'GET' ? '' : JSON.stringify(data))
  const body = JSON.parse(response.body)
  if (response.status >= 400) throw new Error(`${url}: ${body.message}`)
  return body
}
try {
  const initial = await request('POST', '/api/account/key', { key })
  console.log(JSON.stringify({ apiKeyVerified: initial.authMode === 'api_key', officialBalance: initial.apiBalance }))
  await writeFile(path.join(directory, 'fixture.txt'), '社区活动：星期六上午九点，公园集合，自带水杯。\n')
  const created = await request('POST', '/api/tasks', { prompt: '为周六上午九点在公园集合的社区散步活动写一份简短通知，提醒自带水杯。只需 Markdown 通知，不需要查找其他文件。', locale: 'zh' })
  assert.ok(created.candidates.length >= 1 && created.candidates.length <= 3)
  console.log(JSON.stringify({ liveCandidates: created.candidates.length }))
  let plan
  for (let i = 0; i < 3; i++) {
    plan = await request('POST', `/api/tasks/${created.task.id}/clarifications`, { content: '请生成一份简短友好的 Markdown 社区散步通知：周六上午九点在公园集合，自带水杯。信息已齐全。仅使用本次提供的说明，不查找其他文件。', locale: 'zh' })
    if (plan.task.status === 'READY_TO_RUN') break
  }
  assert.equal(plan.task.status, 'READY_TO_RUN')
  await request('POST', `/api/tasks/${created.task.id}/access-scope`, { roots: [directory], network: true })
  const completed = await request('POST', `/api/tasks/${created.task.id}/run`)
  assert.ok(completed.suggestions.length)
  assert.ok(completed.feedbackOptions.length >= 2)
  const revised = await request('POST', `/api/tasks/${created.task.id}/feedback`, { category: completed.feedbackOptions[0], comment: '请把语气改得更亲切一点。', good: false })
  assert.ok(revised.pendingQuestion)
  const final = await request('GET', '/api/account/status?refresh=1')
  console.log(JSON.stringify({ liveClarification: true, liveResult: true, liveFeedback: true, usage: final.usage, officialBalanceAfter: final.apiBalance }))
} finally {
  runtime.dispose()
  await rm(directory, { recursive: true, force: true })
}
