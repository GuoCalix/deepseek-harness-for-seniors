import { spawn, type ChildProcess } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const port = 4180
let server: ChildProcess

async function waitForServer() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`)
      if (response.ok) return
    } catch { /* the child is still starting */ }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error('local API did not start')
}

describe('local task engine', () => {
  beforeAll(async () => {
    server = spawn(process.execPath, ['app/server/index.mjs'], { env: { ...process.env, NODE_ENV: '', VITEST: '', AI_OLD_ALLOW_MOCK: 'true', AI_OLD_API_PORT: String(port) }, stdio: 'ignore' })
    await waitForServer()
  })
  afterAll(() => server.kill())

  it('reports a healthy local service', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`)
    expect(await response.json()).toMatchObject({ ok: true, service: 'ai-for-the-old-local' })
  })

  it('offers no more than three intent candidates', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/tasks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: '帮我整理桌面的照片' }) })
    const { candidates: options, task } = await response.json() as { candidates: { id: string }[]; task: { status: string; turns: { content: string }[] } }
    expect(options).toHaveLength(3)
    expect(options.map(option => option.id)).toEqual(['photos-by-date', 'photos-by-person', 'photos-inventory'])
    expect(task.status).toBe('CLARIFYING')
    expect(task.turns[0].content).toContain('照片')
  })

  it('transitions a task into a resumable ready state', async () => {
    const created = await fetch(`http://127.0.0.1:${port}/api/tasks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: '生成社区通知' }) }).then(response => response.json()) as { task: { id: string } }
    const response = await fetch(`http://127.0.0.1:${port}/api/tasks/${created.task.id}/clarifications`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: '写一份清楚的通知' }) })
    const body = await response.json() as { task: { status: string; events: { type: string }[] }; preview: { output: string } }
    expect(body.task.status).toBe('READY_TO_RUN')
    expect(body.task.events.at(-1)?.type).toBe('clarification.confirmed')
    expect(body.preview.output).toContain('workspace')
  })
})
