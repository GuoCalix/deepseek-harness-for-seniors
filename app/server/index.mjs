import { createServer } from 'node:http'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { Readable } from 'node:stream'
import { createAccountService } from './account.mjs'
import { credentialStore } from './storage.mjs'
import { usageStore } from './usage.mjs'
import { origin, requestJson } from './network.mjs'

const port = Number(process.env.AI_OLD_API_PORT ?? 4179)
const dataDir = process.env.AI_OLD_DATA_DIR ?? path.join(process.cwd(), 'app', 'data')
const tasksFile = path.join(dataDir, 'tasks.json')
const desktop = path.join(os.homedir(), 'Desktop')
const workspaceRoot = process.env.AI_OLD_WORKSPACE_ROOT ?? path.join(desktop, 'AI for the old')
const inferenceOrigin = origin(process.env.DEEPSEEK_INFERENCE_ORIGIN, 'https://api.deepseek.com')
const allowedTools = ['list_files', 'read_metadata', 'read_text', 'copy_files', 'create_directory', 'write_text', 'convert_document', 'create_spreadsheet', 'open_result']
const allowMockModel = process.env.AI_OLD_ALLOW_MOCK === 'true'
const now = () => new Date().toISOString()
const id = prefix => `${prefix}_${crypto.randomUUID().slice(0, 8)}`
const json = (value, status = 200) => ({ status, body: JSON.stringify(value), headers: { 'content-type': 'application/json; charset=utf-8' } })
const usage = usageStore(dataDir)
let account
let desktopMode = false
function configureDesktop(safeStorage) { desktopMode = true; initializeAccount(safeStorage) }
function initializeAccount(codec) {
  if (account) return account
  account = createAccountService({
    store: credentialStore(dataDir, codec), dataDir,
    callbackOrigin: () => `http://127.0.0.1:${httpServer.address()?.port || port}`,
    platformOrigin: process.env.DEEPSEEK_PLATFORM_ORIGIN,
    inferenceOrigin, apiKey: process.env.DEEPSEEK_API_KEY,
  })
  return account
}
async function accountStatus(refresh = false) {
  return { ...await initializeAccount().status(refresh), usage: await usage.read() }
}

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
  const response = await callDeepSeek([
    { role: 'system', content: `你是面向中老年用户的任务澄清助手。根据用户的一句话，提出最多三个互不重复、容易理解的候选意图。只返回 JSON，不要解释，不要输出命令。每个候选必须有 title、description、needs 字段。title 和 description 使用 ${locale === 'en' ? 'English' : '简体中文'}。` },
    { role: 'user', content: JSON.stringify({ prompt, output_schema: { candidates: [{ title: 'string', description: 'string', needs: 'string' }] } }) },
  ])
  const raw = response?.content ?? null
  if (raw === null) {
    if (allowMockModel) return fallback
    throw new Error('未配置 DEEPSEEK_API_KEY，无法生成实时候选意图')
  }
  return validateCandidates(modelJson(raw))
}

async function generatePlan(task, content, locale = 'zh') {
  const fallback = { nextAction: 'ready_to_run', question: '', target: content, output: '任务 workspace/output/任务说明.md', network: '需要联网调用 DeepSeek 生成结果说明', summary: content }
  const response = await callDeepSeek([
    { role: 'system', content: `你是任务澄清与执行预览助手。一次只提出一个问题；当目标、范围和产物足够明确时返回 ready_to_run，否则返回 ask_question。只返回 JSON，不要思维过程，不要 shell 命令。输出 ${locale === 'en' ? 'English' : '简体中文'}。` },
    { role: 'user', content: JSON.stringify({ original_prompt: task.prompt, previous_turns: task.turns, latest_answer: content, output_schema: { next_action: 'ready_to_run | ask_question', question: 'string', target: 'string', output: 'string', network: 'string', summary: 'string' } }) },
  ])
  const raw = response?.content ?? null
  if (raw === null) {
    if (allowMockModel) return fallback
    throw new Error('未配置 DEEPSEEK_API_KEY，无法生成实时澄清结果')
  }
  return validatePlan(modelJson(raw))
}

async function generateResult(task, files, locale = 'zh') {
  const fallback = { summary: `已完成“${task.title}”，原始文件未修改。`, suggestions: ['请打开 output 文件夹检查主要产物。', '如有遗漏，可以在本任务中提交反馈。'], feedbackOptions: ['文件找错了', '内容不准确', '格式或排版不合适', '漏掉了一些内容', '我想换一种做法', '其他问题'], markdown: '' }
  const metadata = files.slice(0, 80).map(file => ({ name: file.name, extension: file.extension, size: file.size, modifiedAt: file.modifiedAt }))
  const response = await callDeepSeek([
    { role: 'system', content: `你是本地任务结果审阅助手。根据任务和文件元数据，生成给中老年用户看的简短结果说明、最多五条下一步建议、二到七条反馈选项，以及一段 Markdown 报告正文。不要虚构已执行的操作，不要输出思维过程或命令。只返回 JSON，语言为 ${locale === 'en' ? 'English' : '简体中文'}。` },
    { role: 'user', content: JSON.stringify({ task: { title: task.title, prompt: task.prompt, confirmed_turns: task.turns }, files: metadata, output_schema: { summary: 'string', suggestions: ['string'], feedback_options: ['string'], markdown: 'string' } }) },
  ])
  const raw = response?.content ?? null
  if (raw === null) {
    if (allowMockModel) return fallback
    throw new Error('未配置 DEEPSEEK_API_KEY，无法生成实时结果建议')
  }
  return validateResult(modelJson(raw))
}

async function generateRevision(task, category, comment, locale = 'zh') {
  const response = await callDeepSeek([
    { role: 'system', content: `你是任务修改助手。根据用户对结果的反馈，生成下一轮唯一需要确认的问题。只返回 JSON，不要思维过程，语言为 ${locale === 'en' ? 'English' : '简体中文'}。` },
    { role: 'user', content: JSON.stringify({ task: task.title, feedback: category, comment, output_schema: { question: 'string' } }) },
  ])
  const raw = response?.content ?? null
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
  const credential = await initializeAccount().credential()
  if (credential.mode === 'none') {
    if (allowMockModel) return null
    throw new Error('DeepSeek 未连接，请登录账号或在账户页面连接 API key / Connect your account or API key')
  }
  const isAccount = credential.mode === 'account'
  const headers = { 'content-type': 'application/json', ...(isAccount ? { 'x-dsh-auth-token': credential.token, 'anthropic-version': '2023-06-01' } : { authorization: `Bearer ${credential.token}` }) }
  const model = process.env.DEEPSEEK_MODEL ?? 'deepseek-chat'
  const payload = isAccount
    ? { model, max_tokens: 4096, stream: false, thinking: { type: 'disabled' }, temperature: 0.2,
        system: messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n'),
        messages: messages.filter(m => m.role !== 'system').map(m => ({ role: m.role, content: m.content })) }
    : { model, max_tokens: 4096, messages, temperature: 0.2, response_format: { type: 'json_object' } }
  const body = await requestJson(`${inferenceOrigin}${isAccount ? '/anthropic/v1/messages' : '/chat/completions'}`, { method: 'POST', headers, body: JSON.stringify(payload) }, 2 * 1024 * 1024)
  const content = isAccount ? body.content?.filter(item => item.type === 'text').map(item => item.text).join('') : body.choices?.[0]?.message?.content
  const exact = body.usage && Number.isSafeInteger(body.usage.prompt_tokens ?? body.usage.input_tokens) && Number.isSafeInteger(body.usage.completion_tokens ?? body.usage.output_tokens)
  const measured = exact ? body.usage : { input_tokens: messages.reduce((total, message) => total + Math.ceil(JSON.stringify(message).length / 4) + 4, 0), output_tokens: Math.ceil(String(content ?? '').length / 4) }
  await usage.record(measured, !exact, isAccount)
  if (typeof content !== 'string' || !content.trim()) throw new Error('DeepSeek returned no usable answer; retry the request')
  return { content, usage: measured, authMode: credential.mode }
}

async function parseBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) { size += chunk.length; if (size > 1_048_576) throw new Error('Request is too large'); chunks.push(chunk) }
  if (!chunks.length) return {}
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new Error('请求格式不正确') }
}

async function route(req, url) {
  const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await parseBody(req) : {}
  const tasks = await readTasks()
  if (req.method === 'GET' && url.pathname === '/api/health') return json({ ok: true, service: 'ai-for-the-old-local', version: '0.1.3', deepseekConfigured: Boolean(process.env.DEEPSEEK_API_KEY) })
  if (req.method === 'GET' && url.pathname === '/api/account/status') return json(await accountStatus(url.searchParams.get('refresh') === '1'))
  if (req.method === 'POST' && url.pathname === '/api/account/login/start') return json(await initializeAccount().start(body.locale === 'en' ? 'en' : 'zh'))
  if (req.method === 'POST' && url.pathname === '/api/account/login/cancel') { await initializeAccount().cancel(); return json(await accountStatus()) }
  if (req.method === 'POST' && url.pathname === '/api/account/logout') { await initializeAccount().logout(); return json(await accountStatus()) }
  if (req.method === 'POST' && url.pathname === '/api/account/key') { await initializeAccount().setApiKey(body.key); return json(await accountStatus()) }
  if (req.method === 'POST' && url.pathname === '/api/account/key/remove') { await initializeAccount().removeApiKey(); return json(await accountStatus()) }
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

async function dispatch(method, pathname, body = '') {
  if (!['GET', 'POST'].includes(method) || typeof pathname !== 'string' || !/^\/api\/[a-zA-Z0-9_/?=&-]+$/.test(pathname) || typeof body !== 'string' || Buffer.byteLength(body) > 1_048_576) return json({ message: 'Invalid local request' }, 400)
  const request = Readable.from(body ? [Buffer.from(body)] : [])
  request.method = method
  try { return await route(request, new URL(pathname, 'http://127.0.0.1')) }
  catch (error) { return json({ code: 'request_failed', message: error instanceof Error ? error.message : 'Local request failed' }, 503) }
}

const httpServer = createServer(async (req, res) => {
  res.setHeader('cache-control', 'no-store')
  try {
    const bound = httpServer.address()?.port
    if (![`127.0.0.1:${bound}`, `localhost:${bound}`].includes(req.headers.host)) { res.writeHead(403).end(); return }
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${bound}`)
    if (req.method === 'GET' && url.pathname === '/oauth/callback') {
      const result = await initializeAccount().callback(url)
      res.writeHead(result.status, { ...(result.location ? { location: result.location } : {}), 'content-type': 'text/plain; charset=utf-8', 'content-security-policy': "default-src 'none'", 'referrer-policy': 'no-referrer' })
      res.end(result.status === 302 ? '' : '登录未完成，请返回应用重试。 / Sign-in did not complete. Return to the app and retry.')
      return
    }
    // Packaged UI talks through authenticated Electron IPC, never a public loopback API.
    if (desktopMode) { res.writeHead(403).end(); return }
    const origin = req.headers.origin
    if (origin && !['http://127.0.0.1:4178', 'http://localhost:4178', `http://127.0.0.1:${bound}`].includes(origin)) { res.writeHead(403).end(); return }
    if (origin) { res.setHeader('access-control-allow-origin', origin); res.setHeader('vary', 'Origin') }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type' }).end()
      return
    }
    if (req.method === 'POST' && !String(req.headers['content-type'] ?? '').startsWith('application/json')) { res.writeHead(415).end(); return }
    const result = await route(req, url)
    res.writeHead(result.status, result.headers).end(result.body)
  } catch (error) {
    res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify({ code: 'request_failed', message: error instanceof Error ? error.message : 'Local service failed' }))
  }
})

async function startServer(listenPort = port) {
  if (httpServer.listening) return httpServer
  await new Promise((resolve, reject) => {
    const fail = error => { httpServer.off('listening', listening); reject(error) }
    const listening = () => { httpServer.off('error', fail); resolve() }
    httpServer.once('error', fail).once('listening', listening).listen(listenPort, '127.0.0.1')
  })
  return httpServer
}
if (process.env.AI_OLD_DESKTOP !== '1' && process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
  startServer().then(() => console.log(`AI for the old local API listening on http://127.0.0.1:${httpServer.address().port}`)).catch(() => { console.error('Local API could not start: check the configured port'); process.exitCode = 1 })
}
function dispose() { account?.dispose(); httpServer.close() }

export { allowedTools, fallbackCandidates, createTask, generateCandidates, generatePlan, generateResult, listFiles, slug, httpServer, startServer, configureDesktop, dispatch, dispose }
