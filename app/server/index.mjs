import { createServer } from 'node:http'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

const port = Number(process.env.AI_OLD_API_PORT ?? 4179)
const dataDir = process.env.AI_OLD_DATA_DIR ?? path.join(process.cwd(), 'app', 'data')
const tasksFile = path.join(dataDir, 'tasks.json')
const desktop = path.join(os.homedir(), 'Desktop')
const workspaceRoot = process.env.AI_OLD_WORKSPACE_ROOT ?? path.join(desktop, 'AI for the old')
const allowedTools = ['list_files', 'read_metadata', 'read_text', 'copy_files', 'create_directory', 'write_text', 'convert_document', 'create_spreadsheet', 'open_result']
const allowMockModel = process.env.AI_OLD_ALLOW_MOCK === 'true' || process.env.NODE_ENV === 'test'

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

async function createTask(prompt, candidateOptions = []) {
  const createdAt = now()
  const title = titleFor(prompt)
  return {
    id: id('task'), title, prompt, status: 'CLARIFYING', stage: 'clarifying', createdAt, updatedAt: createdAt,
    workspacePath: null, turns: [{ id: id('turn'), role: 'user', content: prompt, createdAt }],
    events: [event('task.created', '已记录你的需求')], artifacts: [], feedback: [], candidateOptions,
    accessScope: null, version: 1, foundFiles: 0, completedSteps: 0, totalSteps: 5, elapsedSeconds: 0,
  }
}

function fallbackCandidates(prompt) {
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

function modelJson(content) {
  const cleaned = String(content ?? '').trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '')
  try { return JSON.parse(cleaned) }
  catch { throw new Error('DeepSeek 返回的 JSON 无法解析') }
}

function requireString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`DeepSeek 返回缺少 ${label}`)
  return value.trim()
}

function validateCandidates(value) {
  if (!value || !Array.isArray(value.candidates) || value.candidates.length < 1 || value.candidates.length > 3) throw new Error('DeepSeek 必须返回 1 到 3 个候选意图')
  return value.candidates.map((item, index) => ({
    id: slug(requireString(item.title, `候选 ${index + 1} 标题`)),
    title: requireString(item.title, `候选 ${index + 1} 标题`),
    description: requireString(item.description, `候选 ${index + 1} 描述`),
    needs: requireString(item.needs, `候选 ${index + 1} 文件范围`),
  }))
}

function validatePlan(value) {
  const action = value?.next_action
  if (action !== 'ready_to_run' && action !== 'ask_question') throw new Error('DeepSeek 返回了未知的澄清动作')
  const plan = {
    nextAction: action,
    question: typeof value.question === 'string' ? value.question.trim() : '',
    target: requireString(value.target, '任务目标'),
    output: requireString(value.output, '预计产物'),
    network: requireString(value.network, '联网说明'),
    summary: requireString(value.summary, '确认摘要'),
  }
  if (action === 'ask_question' && !plan.question) throw new Error('需要继续澄清时必须返回问题')
  return plan
}

function validateResult(value) {
  if (!value || typeof value !== 'object') throw new Error('DeepSeek 结果不是对象')
  const summary = requireString(value.summary, '结果摘要')
  const suggestions = Array.isArray(value.suggestions) ? value.suggestions.map(item => requireString(item, '建议')).slice(0, 5) : []
  const feedbackOptions = Array.isArray(value.feedback_options) ? value.feedback_options.map(item => requireString(item, '反馈选项')).slice(0, 7) : []
  if (feedbackOptions.length < 2) throw new Error('DeepSeek 至少需要返回两个反馈选项')
  return { summary, suggestions, feedbackOptions, markdown: typeof value.markdown === 'string' && value.markdown.trim() ? value.markdown.trim() : summary }
}

async function generateCandidates(prompt, locale = 'zh') {
  const fallback = fallbackCandidates(prompt)
  const raw = await callDeepSeek([
    { role: 'system', content: `你是面向中老年用户的任务澄清助手。根据用户的一句话，提出最多三个互不重复、容易理解的候选意图。只返回 JSON，不要解释，不要输出命令。每个候选必须有 title、description、needs 字段。title 和 description 使用 ${locale === 'en' ? 'English' : '简体中文'}。` },
    { role: 'user', content: JSON.stringify({ prompt, output_schema: { candidates: [{ title: 'string', description: 'string', needs: 'string' }] } }) },
  ])
  if (raw === null) {
    if (allowMockModel) return fallback
    throw new Error('未配置 DEEPSEEK_API_KEY，无法生成实时候选意图')
  }
  return validateCandidates(modelJson(raw))
}

async function generatePlan(task, content, locale = 'zh') {
  const fallback = { nextAction: 'ready_to_run', question: '', target: content, output: '任务 workspace/output/任务说明.md', network: '需要联网调用 DeepSeek 生成结果说明', summary: content }
  const raw = await callDeepSeek([
    { role: 'system', content: `你是任务澄清与执行预览助手。一次只提出一个问题；当目标、范围和产物足够明确时返回 ready_to_run，否则返回 ask_question。只返回 JSON，不要思维过程，不要 shell 命令。输出 ${locale === 'en' ? 'English' : '简体中文'}。` },
    { role: 'user', content: JSON.stringify({ original_prompt: task.prompt, previous_turns: task.turns, latest_answer: content, output_schema: { next_action: 'ready_to_run | ask_question', question: 'string', target: 'string', output: 'string', network: 'string', summary: 'string' } }) },
  ])
  if (raw === null) {
    if (allowMockModel) return fallback
    throw new Error('未配置 DEEPSEEK_API_KEY，无法生成实时澄清结果')
  }
  return validatePlan(modelJson(raw))
}

async function generateResult(task, files, locale = 'zh') {
  const fallback = { summary: `已完成“${task.title}”，原始文件未修改。`, suggestions: ['请打开 output 文件夹检查主要产物。', '如有遗漏，可以在本任务中提交反馈。'], feedbackOptions: ['文件找错了', '内容不准确', '格式或排版不合适', '漏掉了一些内容', '我想换一种做法', '其他问题'], markdown: '' }
  const metadata = files.slice(0, 80).map(file => ({ name: file.name, extension: file.extension, size: file.size, modifiedAt: file.modifiedAt }))
  const raw = await callDeepSeek([
    { role: 'system', content: `你是本地任务结果审阅助手。根据任务和文件元数据，生成给中老年用户看的简短结果说明、最多五条下一步建议、二到七条反馈选项，以及一段 Markdown 报告正文。不要虚构已执行的操作，不要输出思维过程或命令。只返回 JSON，语言为 ${locale === 'en' ? 'English' : '简体中文'}。` },
    { role: 'user', content: JSON.stringify({ task: { title: task.title, prompt: task.prompt, confirmed_turns: task.turns }, files: metadata, output_schema: { summary: 'string', suggestions: ['string'], feedback_options: ['string'], markdown: 'string' } }) },
  ])
  if (raw === null) {
    if (allowMockModel) return fallback
    throw new Error('未配置 DEEPSEEK_API_KEY，无法生成实时结果建议')
  }
  return validateResult(modelJson(raw))
}

async function generateRevision(task, category, comment, locale = 'zh') {
  const raw = await callDeepSeek([
    { role: 'system', content: `你是任务修改助手。根据用户对结果的反馈，生成下一轮唯一需要确认的问题。只返回 JSON，不要思维过程，语言为 ${locale === 'en' ? 'English' : '简体中文'}。` },
    { role: 'user', content: JSON.stringify({ task: task.title, feedback: category, comment, output_schema: { question: 'string' } }) },
  ])
  if (raw === null) {
    if (allowMockModel) return { question: `你希望我如何处理“${category}”？` }
    throw new Error('未配置 DEEPSEEK_API_KEY，无法生成实时修改问题')
  }
  return { question: requireString(modelJson(raw).question, '修改问题') }
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

async function runTask(task, scope = {}, locale = 'zh') {
  const workspace = task.workspacePath ?? await createWorkspace(task.title)
  const searchRoots = Array.isArray(scope.roots) && scope.roots.length ? scope.roots : [desktop, path.join(os.homedir(), 'Downloads')]
  const files = []
  for (const root of searchRoots) files.push(...await listFiles(root))
  const unique = [...new Map(files.map(file => [file.path, file])).values()]
  const outputName = `${slug(task.title)}-任务说明.md`
  const outputPath = path.join(workspace, 'output', outputName)
  const narrative = await generateResult(task, unique, locale)
  const report = `# ${task.title}\n\n${narrative.markdown}\n\n## 文件摘要\n\n${unique.slice(0, 30).map(file => `- ${file.name}（${Math.ceil(file.size / 1024)} KB）\n  - ${file.path}`).join('\n') || '- 暂未找到可列出的文件'}\n\n## 下一步建议\n\n${narrative.suggestions.map(item => `- ${item}`).join('\n')}`
  await fs.writeFile(outputPath, report, 'utf8')
  await fs.writeFile(path.join(workspace, 'logs', 'execution.jsonl'), `${JSON.stringify({ at: now(), tool: 'list_files', count: unique.length })}\n`, 'utf8')
  const updated = { ...task, status: 'COMPLETED', stage: 'completed', updatedAt: now(), workspacePath: workspace, foundFiles: unique.length, completedSteps: 5, elapsedSeconds: Math.max(4, unique.length), resultSummary: narrative.summary, suggestions: narrative.suggestions, feedbackOptions: narrative.feedbackOptions, artifacts: [{ id: id('artifact'), name: outputName, path: outputPath, kind: 'markdown', size: Buffer.byteLength(report), generatedAt: now(), version: task.version }], events: [...task.events, event('task.progress', '正在查找文件', { foundFiles: unique.length }), event('task.completed', '已经完成，结果已放入任务文件夹')], version: task.version }
  return updated
}

async function callDeepSeek(messages) {
  const key = process.env.DEEPSEEK_API_KEY
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
  if (req.method === 'GET' && url.pathname === '/api/health') return json({ ok: true, service: 'ai-for-the-old-local', version: '0.1.2', deepseekConfigured: Boolean(process.env.DEEPSEEK_API_KEY) })
  if (req.method === 'GET' && url.pathname === '/api/account/status') return json({ provider: 'DeepSeek', apiConfigured: Boolean(process.env.DEEPSEEK_API_KEY), webLoginTransfer: false, balance: null, billing: 'official_platform_only' })
  if (req.method === 'GET' && url.pathname === '/api/tasks') return json(tasks.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(task => ({ ...task, candidateOptions: task.candidateOptions ?? [] })))
  if (req.method === 'POST' && url.pathname === '/api/tasks') {
    if (typeof body.prompt !== 'string' || !body.prompt.trim()) return json({ code: 'prompt_required', message: '请先告诉我想完成什么事' }, 400)
    const locale = body.locale === 'en' ? 'en' : 'zh'
    const candidateOptions = await generateCandidates(body.prompt, locale)
    const task = await createTask(body.prompt, candidateOptions)
    task.locale = locale
    tasks.push(task); await writeTasks(tasks)
    return json({ task, candidates: candidateOptions }, 201)
  }
  if (req.method === 'POST' && url.pathname === '/api/deepseek/chat') {
    try { return json({ content: await callDeepSeek(body.messages ?? []) }) }
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
    const locale = body.locale === 'en' ? 'en' : task.locale ?? 'zh'
    const plan = await generatePlan(task, content, locale)
    const assistantTurn = plan.nextAction === 'ask_question' ? { id: id('turn'), role: 'assistant', content: plan.question, createdAt: now() } : null
    const next = { ...task, locale, status: plan.nextAction === 'ask_question' ? 'CLARIFYING' : 'READY_TO_RUN', stage: plan.nextAction === 'ask_question' ? 'clarifying' : 'ready', pendingQuestion: plan.nextAction === 'ask_question' ? plan.question : undefined, modelSummary: plan.summary, updatedAt: now(), turns: [...task.turns, { id: id('turn'), role: 'user', content, createdAt: now() }, ...(assistantTurn ? [assistantTurn] : [])], events: [...task.events, event(plan.nextAction === 'ask_question' ? 'clarification.question' : 'clarification.confirmed', plan.nextAction === 'ask_question' ? 'DeepSeek 正在继续确认一个问题' : 'DeepSeek 已确认任务目标')] }
    tasks[index] = next; await writeTasks(tasks)
    return json({ task: next, preview: plan.nextAction === 'ready_to_run' ? { target: plan.target, roots: [desktop, path.join(os.homedir(), 'Downloads')], output: plan.output, network: plan.network, summary: plan.summary } : null, question: plan.question || undefined })
  }
  if (req.method === 'POST' && action === 'access-scope') {
    const next = { ...task, accessScope: { roots: body.roots ?? [desktop, path.join(os.homedir(), 'Downloads')], network: Boolean(body.network), agreedAt: now() }, status: 'ACCESS_PENDING', stage: 'access', updatedAt: now(), events: [...task.events, event('access.approved', '已记录本次任务的访问范围')] }
    tasks[index] = next; await writeTasks(tasks); return json(next)
  }
  if (req.method === 'POST' && action === 'run') {
    if (!['READY_TO_RUN', 'ACCESS_PENDING', 'PAUSED', 'FAILED'].includes(task.status)) return json({ code: 'task_not_ready', message: '这个任务还没有准备好执行' }, 409)
    const next = await runTask({ ...task, status: 'RUNNING', stage: 'running' }, task.accessScope ?? body, task.locale ?? 'zh')
    tasks[index] = next; await writeTasks(tasks); return json(next)
  }
  if (req.method === 'POST' && action === 'feedback') {
    const category = String(body.category ?? '').trim()
    if (!category) return json({ code: 'feedback_required', message: '请选择一项反馈' }, 400)
    const comment = String(body.comment ?? '')
    const satisfied = Boolean(body.good) || category === '没有问题，完成得很好'
    const revision = satisfied ? null : await generateRevision(task, category, comment, task.locale ?? 'zh')
    const next = { ...task, status: satisfied ? 'COMPLETED' : 'REVISION', stage: satisfied ? 'completed' : 'clarifying', pendingQuestion: revision?.question, updatedAt: now(), feedback: [...task.feedback, { id: id('feedback'), category, comment, createdAt: now() }], turns: revision ? [...task.turns, { id: id('turn'), role: 'assistant', content: revision.question, createdAt: now() }] : task.turns, events: [...task.events, event('feedback.received', category)] }
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
    const message = error instanceof Error ? error.message : '本地服务发生错误'
    const providerFailure = message.includes('DeepSeek') || message.includes('DEEPSEEK_API_KEY')
    res.writeHead(providerFailure ? 503 : 500, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ code: providerFailure ? 'deepseek_unavailable' : 'internal_error', message }))
  }
})

if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
  httpServer.listen(port, '127.0.0.1', () => console.log(`AI for the old local API listening on http://127.0.0.1:${port}`))
}

export { allowedTools, fallbackCandidates, createTask, generateCandidates, generatePlan, generateResult, listFiles, slug, httpServer }
