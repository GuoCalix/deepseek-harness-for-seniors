import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm, mkdir, writeFile, access } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

let port: number
let directory: string
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
    directory = await mkdtemp(path.join(os.tmpdir(), 'ai-old-api-test-'))
    await Promise.all([mkdir(path.join(directory, 'Desktop')), mkdir(path.join(directory, 'Downloads'))])
    server = spawn(process.execPath, ['app/server/index.mjs'], { env: { ...process.env, NODE_ENV: '', VITEST: '', DEEPSEEK_API_KEY: '', AI_OLD_DESKTOP: '', AI_OLD_DESKTOP_PATH: path.join(directory, 'Desktop'), AI_OLD_DOWNLOADS_PATH: path.join(directory, 'Downloads'), AI_OLD_DATA_DIR: directory, AI_OLD_WORKSPACE_ROOT: path.join(directory, 'workspace'), AI_OLD_ALLOW_MOCK: 'true', AI_OLD_API_PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] })
    await new Promise<void>((resolve, reject) => {
      server.stdout!.on('data', data => { const match = String(data).match(/127\.0\.0\.1:(\d+)/); if (match) { port = Number(match[1]); resolve() } })
      server.once('exit', () => reject(new Error('Test API exited before listening')))
    })
    await waitForServer()
  })
  afterAll(async () => { const stopped = new Promise(resolve => server.once('exit', resolve)); server.kill(); await stopped; await rm(directory, { recursive: true, force: true }) })

  it('reports a healthy local service', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`)
    expect(await response.json()).toMatchObject({ ok: true, service: 'ai-for-the-old-local' })
  })

  it('keeps account credentials out of the renderer projection', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/account/status`)
    const body = await response.json() as { account: { status: string }; balance: unknown; usage: { requests: number } }
    expect(body.account.status).toBe('signed-out')
    expect(body.balance).toBeNull()
    expect(body.usage).toHaveProperty('requests')
  })

  it('rejects cross-site writes and text/plain submissions before routing', async () => {
    const forbidden = await fetch(`http://127.0.0.1:${port}/api/tasks`, { method: 'POST', headers: { origin: 'https://untrusted.example', 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'test' }) })
    expect(forbidden.status).toBe(403)
    const form = await fetch(`http://127.0.0.1:${port}/api/tasks`, { method: 'POST', body: JSON.stringify({ prompt: 'test' }) })
    expect(form.status).toBe(415)
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

  it('executes a confirmed delete through the structured tool and records one access grant', async () => {
    const installer = path.join(directory, 'Desktop', '安装包.dmg')
    await writeFile(installer, 'fixture')
    const created = await fetch(`http://127.0.0.1:${port}/api/tasks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: '删除桌面上的安装包' }) }).then(response => response.json()) as { task: { id: string } }
    const clarified = await fetch(`http://127.0.0.1:${port}/api/tasks/${created.task.id}/clarifications`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: '删除桌面上的安装包' }) }).then(response => response.json()) as { preview: { roots: string[] } }
    const response = await fetch(`http://127.0.0.1:${port}/api/tasks/${created.task.id}/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ roots: clarified.preview.roots, network: true }) })
    const result = await response.json() as { status: string; accessScope: { roots: string[] }; events: { type: string }[]; workspacePath: string }
    expect(response.status).toBe(200)
    expect(result.status).toBe('COMPLETED')
    expect(result.accessScope.roots).toEqual([path.join(directory, 'Desktop')])
    expect(result.events.filter(item => item.type === 'access.approved')).toHaveLength(1)
    await expect(access(installer)).rejects.toThrow()
    await access(path.join(result.workspacePath, 'output'))
  })

  it('persists a failed execution when a plan exceeds the approved roots', async () => {
    const created = await fetch(`http://127.0.0.1:${port}/api/tasks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: '整理桌面文件' }) }).then(response => response.json()) as { task: { id: string } }
    await fetch(`http://127.0.0.1:${port}/api/tasks/${created.task.id}/clarifications`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: '整理桌面文件' }) })
    const response = await fetch(`http://127.0.0.1:${port}/api/tasks/${created.task.id}/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ roots: [path.join(directory, 'approved-only')], network: false }) })
    const result = await response.json() as { status: string; failureReason: string }
    expect(response.status).toBe(500)
    expect(result.status).toBe('FAILED')
    expect(result.failureReason).toContain('授权')
  })
})
