import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TOOL_NAMES = new Set(['list_files', 'read_metadata', 'read_text', 'copy_files', 'move_to_trash', 'create_directory', 'write_text', 'convert_document', 'create_spreadsheet', 'open_result'])
const MAX_FILES = 200
const MAX_TEXT = 1_048_576

function within(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)
}

function safeLimit(value) {
  return Number.isInteger(value) && value > 0 ? Math.min(value, MAX_FILES) : MAX_FILES
}

function dateValue(value) {
  if (typeof value !== 'string' || !value.trim()) return undefined
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? undefined : date.valueOf()
}

function matches(file, selectors = {}) {
  const extensions = Array.isArray(selectors.extensions) ? selectors.extensions.map(item => String(item).toLowerCase()) : []
  const names = Array.isArray(selectors.name_contains) ? selectors.name_contains.map(item => String(item).toLowerCase()).filter(Boolean) : []
  const name = file.name.toLowerCase()
  if (extensions.length && !extensions.some(extension => name.endsWith(extension.startsWith('.') ? extension : `.${extension}`))) return false
  if (names.length && !names.some(item => name.includes(item))) return false
  const after = dateValue(selectors.modified_after ?? selectors.created_after)
  const before = dateValue(selectors.modified_before ?? selectors.created_before)
  if (after !== undefined && file.modifiedAt < after) return false
  if (before !== undefined && file.modifiedAt > before) return false
  return true
}

async function walk(root, selectors = {}) {
  const result = []
  const maxDepth = Number.isInteger(selectors.max_depth) ? Math.max(0, Math.min(5, selectors.max_depth)) : 3
  const limit = safeLimit(selectors.limit)
  async function visit(directory, depth) {
    if (result.length >= limit || depth > maxDepth) return
    let entries
    try { entries = await fs.readdir(directory, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (result.length >= limit) break
      if (!selectors.include_hidden && entry.name.startsWith('.')) continue
      const full = path.join(directory, entry.name)
      let stat
      try { stat = await fs.lstat(full) } catch { continue }
      if (entry.isDirectory()) { await visit(full, depth + 1); continue }
      if (!entry.isFile() || !matches({ name: entry.name, modifiedAt: stat.mtimeMs }, selectors)) continue
      result.push({ name: entry.name, path: full, size: stat.size, modifiedAt: stat.mtime.toISOString(), extension: path.extname(entry.name).toLowerCase() })
    }
  }
  await visit(root, 0)
  return result
}

function selectorObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function normaliseRows(value) {
  if (!Array.isArray(value)) return null
  const rows = value.slice(0, 1000).map(row => {
    if (Array.isArray(row)) return row.slice(0, 100).map(cell => String(cell ?? ''))
    if (row && typeof row === 'object') return Object.values(row).slice(0, 100).map(cell => String(cell ?? ''))
    return [String(row ?? '')]
  })
  return rows.length ? rows : null
}

function csvCell(value) {
  const text = String(value ?? '')
  return /[",\n\r]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

function htmlEscape(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}

function markdownHtml(value) {
  return String(value).split(/\r?\n/u).map(line => {
    if (line.startsWith('### ')) return `<h3>${htmlEscape(line.slice(4))}</h3>`
    if (line.startsWith('## ')) return `<h2>${htmlEscape(line.slice(3))}</h2>`
    if (line.startsWith('# ')) return `<h1>${htmlEscape(line.slice(2))}</h1>`
    if (line.startsWith('- ')) return `<li>${htmlEscape(line.slice(2))}</li>`
    return line.trim() ? `<p>${htmlEscape(line)}</p>` : ''
  }).join('\n')
}

function scopeRoot(scope, roots, workspace) {
  if (scope === 'workspace') return workspace
  if (scope === 'desktop') return roots.find(root => root.kind === 'desktop')?.path ?? path.join(os.homedir(), 'Desktop')
  if (scope === 'downloads') return roots.find(root => root.kind === 'downloads')?.path ?? path.join(os.homedir(), 'Downloads')
  if (scope === 'selected') {
    const selected = roots.find(root => root.kind === 'selected')?.path
    if (selected) return selected
    throw new Error('工具计划引用了未选择的文件夹')
  }
  if (typeof scope === 'string' && path.isAbsolute(scope)) return scope
  throw new Error('工具计划引用了未授权的文件范围')
}

function authorizedRoots(scope, desktop, downloads) {
  const values = Array.isArray(scope?.roots) ? scope.roots : []
  const roots = values.filter(value => typeof value === 'string' && path.isAbsolute(value)).map(value => path.resolve(value))
  return [
    { kind: 'desktop', path: path.resolve(desktop), enabled: roots.length === 0 || roots.includes(path.resolve(desktop)) },
    { kind: 'downloads', path: path.resolve(downloads), enabled: roots.length === 0 || roots.includes(path.resolve(downloads)) },
    ...roots.filter(root => ![path.resolve(desktop), path.resolve(downloads)].includes(root)).map(root => ({ kind: 'selected', path: root, enabled: true })),
  ].filter(root => root.enabled)
}

async function moveToTrash(file, workspace, trashRoot) {
  const trash = trashRoot ?? (process.platform === 'darwin' ? path.join(os.homedir(), '.Trash') : path.join(workspace, '.trash'))
  await fs.mkdir(trash, { recursive: true })
  const base = path.basename(file)
  let destination = path.join(trash, base)
  for (let index = 1; ; index += 1) {
    try { await fs.access(destination); destination = path.join(trash, `${path.parse(base).name} (${index})${path.extname(base)}`) } catch { break }
  }
  await fs.rename(file, destination)
  return destination
}

async function availablePath(directory, base) {
  let target = path.join(directory, base)
  for (let index = 1; ; index += 1) {
    try { await fs.access(target); target = path.join(directory, `${path.parse(base).name} (${index})${path.extname(base)}`) } catch { return target }
  }
}

export function validateToolPlan(value) {
  if (!value || !Array.isArray(value.actions) || value.actions.length < 1 || value.actions.length > 20) throw new Error('DeepSeek 返回的工具计划无效')
  const actions = value.actions.map((action, index) => {
    if (!action || !TOOL_NAMES.has(action.tool)) throw new Error(`工具计划第 ${index + 1} 步不在安全白名单中`)
    const sourceScope = typeof action.source_scope === 'string' ? action.source_scope : typeof action.sourceScope === 'string' ? action.sourceScope : 'workspace'
    if (!['desktop', 'downloads', 'workspace', 'selected'].includes(sourceScope) && !path.isAbsolute(sourceScope)) throw new Error('工具计划的文件范围无效')
    return { tool: action.tool, sourceScope, selectors: selectorObject(action.selectors), destination: typeof action.destination === 'string' ? action.destination : '', path: typeof action.path === 'string' ? action.path : '', content: typeof action.content === 'string' ? action.content : '', rows: normaliseRows(action.rows) }
  })
  return { actions, summary: typeof value.summary === 'string' ? value.summary.trim() : '' }
}

export function createToolExecutor({ desktop, downloads, workspace, trashRoot }) {
  const roots = authorizedRoots({}, desktop, downloads)
  function resolveSource(scope, currentScope) {
    const allowed = authorizedRoots(currentScope, desktop, downloads)
    const root = scopeRoot(scope, allowed, workspace)
    if (!allowed.some(item => path.resolve(item.path) === path.resolve(root)) && scope !== 'workspace') throw new Error('工具计划超出了本次已授权的目录')
    return root
  }
  async function ensureWorkspace(target) {
    if (!within(workspace, target) && path.resolve(target) !== path.resolve(workspace)) throw new Error('工具计划只能写入任务 workspace')
    const workspacePath = path.resolve(workspace)
    let probe = path.resolve(target)
    while (true) {
      try {
        const real = await fs.realpath(probe)
        const realWorkspace = await fs.realpath(workspacePath).catch(() => workspacePath)
        if (path.resolve(real) !== realWorkspace && !within(realWorkspace, real)) throw new Error('工具计划不能通过符号链接离开任务 workspace')
        return
      } catch (error) {
        if (error instanceof Error && error.message.includes('符号链接')) throw error
        const parent = path.dirname(probe)
        if (parent === probe) throw new Error('无法验证任务 workspace 路径')
        probe = parent
      }
    }
  }
  async function filesFor(sourceScope, selectors, scope) {
    const root = resolveSource(sourceScope, scope)
    return walk(root, selectors)
  }
  return {
    async run(action, scope = {}) {
      const selectors = selectorObject(action.selectors)
      if (action.tool === 'list_files' || action.tool === 'read_metadata') return { tool: action.tool, files: await filesFor(action.sourceScope, selectors, scope) }
      if (action.tool === 'read_text') {
        const files = await filesFor(action.sourceScope, selectors, scope)
        const selected = files[0]
        if (!selected) return { tool: action.tool, files: [] }
        const text = await fs.readFile(selected.path, 'utf8')
        return { tool: action.tool, file: selected, text: text.slice(0, MAX_TEXT) }
      }
      if (action.tool === 'copy_files') {
        const files = await filesFor(action.sourceScope, selectors, scope)
        const destination = path.resolve(workspace, action.destination || 'input')
        await ensureWorkspace(destination); await fs.mkdir(destination, { recursive: true })
        const copied = []
        for (const file of files) { const target = await availablePath(destination, file.name); await fs.copyFile(file.path, target); copied.push({ ...file, name: path.basename(target), path: target }) }
        return { tool: action.tool, files: copied }
      }
      if (action.tool === 'move_to_trash') {
        const files = await filesFor(action.sourceScope, selectors, scope)
        const moved = []
        for (const file of files) moved.push({ ...file, trashPath: await moveToTrash(file.path, workspace, trashRoot) })
        return { tool: action.tool, files: moved, recoverable: true }
      }
      if (action.tool === 'create_directory') {
        const target = path.resolve(workspace, action.destination || 'work')
        await ensureWorkspace(target); await fs.mkdir(target, { recursive: true }); return { tool: action.tool, path: target }
      }
      if (action.tool === 'write_text') {
        const target = path.resolve(workspace, action.destination || 'output/result.txt')
        const content = action.content.slice(0, MAX_TEXT)
        await ensureWorkspace(target); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, content, 'utf8'); return { tool: action.tool, path: target, size: Buffer.byteLength(content) }
      }
      if (action.tool === 'convert_document') {
        const files = await filesFor(action.sourceScope, selectors, scope)
        const destination = path.resolve(workspace, action.destination || 'output')
        await ensureWorkspace(destination); await fs.mkdir(destination, { recursive: true })
        const converted = []
        for (const file of files) {
          const source = await fs.readFile(file.path, 'utf8')
          const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${htmlEscape(file.name)}</title><style>body{font:16px system-ui;max-width:820px;margin:40px auto;line-height:1.65;padding:0 20px}h1,h2,h3{line-height:1.25}li{margin:.25rem 0}</style></head><body>${markdownHtml(source)}</body></html>`
          const target = await availablePath(destination, `${path.parse(file.name).name}.html`)
          await fs.writeFile(target, html, 'utf8')
          converted.push({ ...file, name: path.basename(target), path: target, size: Buffer.byteLength(html), sourcePath: file.path })
        }
        return { tool: action.tool, files: converted, format: 'html' }
      }
      if (action.tool === 'create_spreadsheet') {
        const rows = normaliseRows(action.rows) ?? (() => {
          try { return normaliseRows(JSON.parse(action.content || '')) } catch { return null }
        })()
        if (!rows) throw new Error('create_spreadsheet 需要 rows 数组或 JSON 表格内容')
        const target = path.resolve(workspace, action.destination || 'output/table.csv')
        await ensureWorkspace(target); await fs.mkdir(path.dirname(target), { recursive: true })
        const csv = `${rows.map(row => row.map(csvCell).join(',')).join('\n')}\n`
        await fs.writeFile(target, csv, 'utf8')
        return { tool: action.tool, files: [{ name: path.basename(target), path: target, size: Buffer.byteLength(csv), extension: '.csv' }], format: 'csv', rows: rows.length }
      }
      if (action.tool === 'open_result') {
        const target = path.resolve(workspace, action.destination || 'output')
        await ensureWorkspace(target); return { tool: action.tool, path: target }
      }
      throw new Error('未实现的工具调用')
    },
    roots,
  }
}

export { MAX_FILES, MAX_TEXT, walk }
