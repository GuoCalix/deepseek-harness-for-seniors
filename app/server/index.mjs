import { createServer } from 'node:http'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

const port = Number(process.env.AI_OLD_API_PORT ?? 4179)
const dataDir = path.join(process.cwd(), 'app', 'data')
const tasksFile = path.join(dataDir, 'tasks.json')
const desktop = path.join(os.homedir(), 'Desktop')
const workspaceRoot = path.join(desktop, 'AI for the old')
const allowedTools = ['list_files', 'read_metadata', 'read_text', 'copy_files', 'create_directory', 'write_text', 'convert_document', 'create_spreadsheet', 'open_result']

const now = () => new Date().toISOString()
const id = (prefix) => `${prefix}_${crypto.randomUUID().slice(0, 8)}`
const json = (value, status = 200) => ({ status, body: JSON.stringify(value) })

async function readTasks() {
  try { return JSON.parse(await fs.readFile(tasksFile, 'utf8')) }
  catch { return [] }
}

async function writeTasks(tasks) {
  await fs.mkdir(dataDir, { recursive: true })
  const temporary = `${tasksFile}.tmp`
  await fs.writeFile(temporary, JSON.stringify(tasks, null, 2), 'utf8')
  await fs.rename(temporary, tasksFile)
}

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/gu, '-').replace(/^-|-$/gu, '').slice(0, 42) || 'new-task'
}

function titleFor(prompt) {
  const trimmed = prompt.trim().replace(/[。.!！?？]+$/u, '')
  return trimmed.length > 26 ? `${trimmed.slice(0, 26)}…` : trimmed || '未命名任务'
}

async function createWorkspace(title) {
  const stamp = new Date().toISOString().slice(0, 10)
  const directory = path.join(workspaceRoot, `${slug(title)}-${stamp}`)
  for (const folder of ['input', 'work', 'output', 'logs']) await fs.mkdir(path.join(directory, folder), { recursive: true })
  return directory
}

function event(type, label, extra = {}) { return { id: id('evt'), type, label, occurredAt: now(), ...extra } }

async function createTask(prompt) {
  const createdAt = now()
  const title = titleFor(prompt)
  return {
    id: id('task'), title, prompt, status: 'CLARIFYING', stage: 'clarifying', createdAt, updatedAt: createdAt,
    workspacePath: null, turns: [{ id: id('turn'), role: 'user', content: prompt, createdAt }],
    events: [event('task.created', '已记录你的需求')], artifacts: [], feedback: [],
    accessScope: null, version: 1, foundFiles: 0, completedSteps: 0, totalSteps: 5, elapsedSeconds: 0,
  }
}

function candidates(prompt) {
  const text = prompt.toLowerCase()
  if (text.includes('照片') || text.includes('图片')) return [
    { id: 'photos-by-date', title: '按日期整理照片', description: '从常用文件夹找出照片，按拍摄年份和月份放进新文件夹。', needs: '桌面、下载、微信文件中的图片' },
    { id: 'photos-by-person', title: '按人物或主题整理', description: '先找到照片，再根据文件名和内容分成几个主题文件夹。', needs: '图片文件和可选的说明' },
    { id: 'photos-inventory', title: '生成照片清单', description: '不移动原文件，只做一份带路径和日期的照片清单。', needs: '图片的文件名、日期和大小' },
  ]
  if (text.includes('通知') || text.includes('文档') || text.includes('材料')) return [
    { id: 'notice', title: '写一份清楚的通知', description: '根据你提供的材料，生成一份可编辑的社区活动通知。', needs: '桌面或下载文件夹中的参考材料' },
    { id: 'summary', title: '整理材料摘要', description: '把材料中的重点、时间和联系人整理成一页摘要。', needs: '文档、图片或 PDF 材料' },
    { id: 'polished-letter', title: '改写成亲切的信件', description: '保留原意，把文字改得更容易读、更亲切。', needs: '原始文字或文档' },
  ]
  return [
    { id: 'file-organize', title: '整理相关文件', description: '找到与你的描述有关的文件，复制到一个清楚的新文件夹。', needs: '桌面、下载和用户选择的文件夹' },
    { id: 'document', title: '生成一份新材料', description: '读取必要的参考内容，生成一份可以继续编辑的材料。', needs: '你允许访问的参考文件' },
    { id: 'inventory', title: '先做一份文件清单', description: '不改动原文件，列出可能相关的文件和所在位置。', needs: '文件名、日期和大小' },
  ]
}

async function listFiles(root, depth = 0, limit = 80, result = []) {
  if (result.length >= limit || depth > 2) return result
  let entries
  try { entries = await fs.readdir(root, { withFileTypes: true }) } catch { return result }
  for (const entry of entries) {
    if (result.length >= limit) break
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) await listFiles(full, depth + 1, limit, result)
    else {
      try {
        const stat = await fs.stat(full)
        result.push({ name: entry.name, path: full, size: stat.size, modifiedAt: stat.mtime.toISOString(), extension: path.extname(entry.name).toLowerCase() })
      } catch { /* a file can disappear during a scan */ }
    }
  }
  return result
}

async function runTask(task, scope = {}) {
  const workspace = task.workspacePath ?? await createWorkspace(task.title)
  const searchRoots = Array.isArray(scope.roots) && scope.roots.length ? scope.roots : [desktop, path.join(os.homedir(), 'Downloads')]
  const files = []
  for (const root of searchRoots) files.push(...await listFiles(root))
  const unique = [...new Map(files.map(file => [file.path, file])).values()]
  const outputName = `${slug(task.title)}-任务说明.md`
  const outputPath = path.join(workspace, 'output', outputName)
  const report = `# ${task.title}\n\n- 生成时间：${now()}\n- 搜索位置：${searchRoots.join('、')}\n- 找到文件：${unique.length} 个\n- 原文件：未修改（所有操作都在 workspace 内完成）\n\n## 文件摘要\n\n${unique.slice(0, 30).map(file => `- ${file.name}（${Math.ceil(file.size / 1024)} KB）\n  - ${file.path}`).join('\n') || '- 暂未找到可列出的文件'}\n\n## 下一步建议\n\n请打开此任务文件夹，检查 output/ 中的结果。原始文件仍在原位置。`
  await fs.writeFile(outputPath, report, 'utf8')
  await fs.writeFile(path.join(workspace, 'logs', 'execution.jsonl'), `${JSON.stringify({ at: now(), tool: 'list_files', count: unique.length })}\n`, 'utf8')
  const updated = { ...task, status: 'COMPLETED', stage: 'completed', updatedAt: now(), workspacePath: workspace, foundFiles: unique.length, completedSteps: 5, elapsedSeconds: Math.max(4, unique.length), artifacts: [{ id: id('artifact'), name: outputName, path: outputPath, kind: 'markdown', size: Buffer.byteLength(report), generatedAt: now(), version: task.version }], events: [...task.events, event('task.progress', '正在查找文件', { foundFiles: unique.length }), event('task.completed', '已经完成，结果已放入任务文件夹')], version: task.version }
  return updated
}

async function callDeepSeek(messages, apiKey) {
  const key = apiKey || process.env.DEEPSEEK_API_KEY
  if (!key) return null
  const response = await fetch('https://api.deepseek.com/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ model: 'deepseek-chat', messages, temperature: 0.2, response_format: { type: 'json_object' } }) })
  if (!response.ok) throw new Error(`DeepSeek request failed (${response.status})`)
  const body = await response.json()
  return body.choices?.[0]?.message?.content ?? null
}

async function parseBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (!chunks.length) return {}
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new Error('请求格式不正确') }
}

async function route(req, url) {
  const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await parseBody(req) : {}
  const tasks = await readTasks()
  if (req.method === 'GET' && url.pathname === '/api/health') return json({ ok: true, service: 'ai-for-the-old-local', version: '0.1.0' })
  if (req.method === 'GET' && url.pathname === '/api/tasks') return json(tasks.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(task => (task.status === 'CLARIFYING' || task.status === 'REVISION') ? { ...task, candidates: candidates(task.prompt) } : task))
  if (req.method === 'POST' && url.pathname === '/api/tasks') {
    if (typeof body.prompt !== 'string' || !body.prompt.trim()) return json({ code: 'prompt_required', message: '请先告诉我想完成什么事' }, 400)
    const task = await createTask(body.prompt)
    tasks.push(task); await writeTasks(tasks)
    return json({ task, candidates: candidates(body.prompt) }, 201)
  }
  if (req.method === 'POST' && url.pathname === '/api/deepseek/chat') {
    try { return json({ content: await callDeepSeek(body.messages ?? [], body.apiKey) }) }
    catch (error) { return json({ code: 'deepseek_error', message: error instanceof Error ? error.message : 'DeepSeek 暂时无法连接' }, 502) }
  }
  const match = url.pathname.match(/^\/api\/tasks\/([^/]+)(?:\/([^/]+))?$/)
  if (!match) return json({ code: 'not_found', message: '找不到这个地址' }, 404)
  const [, taskId, action] = match
  const index = tasks.findIndex(item => item.id === taskId)
  if (index < 0) return json({ code: 'task_not_found', message: '找不到这个任务' }, 404)
  const task = tasks[index]
  if (req.method === 'GET' && !action) return json(task)
  if (req.method === 'POST' && action === 'clarifications') {
    const content = String(body.content ?? '').trim()
    if (!content) return json({ code: 'content_required', message: '请先选择一个方向或补充说明' }, 400)
    const next = { ...task, status: 'READY_TO_RUN', stage: 'ready', updatedAt: now(), turns: [...task.turns, { id: id('turn'), role: 'user', content, createdAt: now() }], events: [...task.events, event('clarification.confirmed', '已确认任务目标')] }
    tasks[index] = next; await writeTasks(tasks)
    return json({ task: next, preview: { target: content, roots: [desktop, path.join(os.homedir(), 'Downloads')], output: '任务 workspace/output/任务说明.md', network: '仅在你配置 DeepSeek API key 时联网' } })
  }
  if (req.method === 'POST' && action === 'access-scope') {
    const next = { ...task, accessScope: { roots: body.roots ?? [desktop, path.join(os.homedir(), 'Downloads')], network: Boolean(body.network), agreedAt: now() }, status: 'ACCESS_PENDING', stage: 'access', updatedAt: now(), events: [...task.events, event('access.approved', '已记录本次任务的访问范围')] }
    tasks[index] = next; await writeTasks(tasks); return json(next)
  }
  if (req.method === 'POST' && action === 'run') {
    if (!['READY_TO_RUN', 'ACCESS_PENDING', 'PAUSED', 'FAILED'].includes(task.status)) return json({ code: 'task_not_ready', message: '这个任务还没有准备好执行' }, 409)
    const next = await runTask({ ...task, status: 'RUNNING', stage: 'running' }, task.accessScope ?? body)
    tasks[index] = next; await writeTasks(tasks); return json(next)
  }
  if (req.method === 'POST' && action === 'feedback') {
    const category = String(body.category ?? '').trim()
    if (!category) return json({ code: 'feedback_required', message: '请选择一项反馈' }, 400)
    const next = { ...task, status: category === '没有问题，完成得很好' ? 'COMPLETED' : 'REVISION', stage: category === '没有问题，完成得很好' ? 'completed' : 'clarifying', updatedAt: now(), feedback: [...task.feedback, { id: id('feedback'), category, comment: String(body.comment ?? ''), createdAt: now() }], events: [...task.events, event('feedback.received', category)] }
    tasks[index] = next; await writeTasks(tasks); return json(next)
  }
  return json({ code: 'method_not_allowed', message: '不支持这个操作' }, 405)
}

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
  try {
    const result = await route(req, url)
    res.writeHead(result.status, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type' })
    res.end(result.body)
  } catch (error) {
    res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ code: 'internal_error', message: error instanceof Error ? error.message : '本地服务发生错误' }))
  }
})

if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
  httpServer.listen(port, '127.0.0.1', () => console.log(`AI for the old local API listening on http://127.0.0.1:${port}`))
}

export { allowedTools, candidates, createTask, listFiles, slug, httpServer }
