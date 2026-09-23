import { mkdtemp, mkdir, readFile, rm, stat, writeFile, access } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createToolExecutor, validateToolPlan } from '../server/tools.mjs'

describe('local structured tool executor', () => {
  it('moves selected installer files to the recoverable Mac Trash', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-old-tools-'))
    const desktop = path.join(root, 'Desktop')
    const downloads = path.join(root, 'Downloads')
    const workspace = path.join(root, 'workspace')
    await Promise.all([mkdir(desktop), mkdir(downloads), mkdir(workspace)])
    const installer = path.join(desktop, '安装包.dmg')
    await writeFile(installer, 'fixture')
    const executor = createToolExecutor({ desktop, downloads, workspace, trashRoot: path.join(root, 'Trash') })
    try {
      const plan = validateToolPlan({ actions: [{ tool: 'move_to_trash', source_scope: 'desktop', selectors: { extensions: ['.dmg'], name_contains: ['安装'] } }] })
      const result = await executor.run(plan.actions[0], { roots: [desktop] })
      expect(result.files).toHaveLength(1)
      expect(result.recoverable).toBe(true)
      await expect(stat(installer)).rejects.toThrow()
      expect(await readFile(result.files[0].trashPath, 'utf8')).toBe('fixture')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects arbitrary commands and writes only inside workspace', async () => {
    expect(() => validateToolPlan({ actions: [{ tool: 'shell', source_scope: 'desktop' }] })).toThrow()
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-old-tools-'))
    const executor = createToolExecutor({ desktop: path.join(root, 'Desktop'), downloads: path.join(root, 'Downloads'), workspace: path.join(root, 'workspace') })
    try { await expect(executor.run({ tool: 'write_text', sourceScope: 'workspace', destination: '../outside', content: 'x', selectors: {} }, { roots: [] })).rejects.toThrow('workspace') }
    finally { await rm(root, { recursive: true, force: true }) }
  })

  it('copies files, creates directories, writes text, converts Markdown and creates CSV', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-old-tools-'))
    const desktop = path.join(root, 'Desktop')
    const downloads = path.join(root, 'Downloads')
    const workspace = path.join(root, 'workspace')
    await Promise.all([mkdir(desktop), mkdir(downloads), mkdir(workspace)])
    await writeFile(path.join(desktop, '说明.md'), '# 标题\n\n- 一项')
    const executor = createToolExecutor({ desktop, downloads, workspace, trashRoot: path.join(root, 'Trash') })
    try {
      const copied = await executor.run({ tool: 'copy_files', sourceScope: 'desktop', destination: 'input', selectors: { extensions: ['.md'] } }, { roots: [desktop] })
      expect(copied.files).toHaveLength(1)
      await executor.run({ tool: 'create_directory', sourceScope: 'workspace', destination: 'output/reports', selectors: {} }, { roots: [desktop] })
      const written = await executor.run({ tool: 'write_text', sourceScope: 'workspace', destination: 'output/reports/note.txt', content: 'hello', selectors: {} }, { roots: [desktop] })
      expect(await readFile(written.path, 'utf8')).toBe('hello')
      const converted = await executor.run({ tool: 'convert_document', sourceScope: 'desktop', destination: 'output/reports', selectors: { extensions: ['.md'] } }, { roots: [desktop] })
      expect(await readFile(converted.files[0].path, 'utf8')).toContain('<h1>标题</h1>')
      const sheet = await executor.run({ tool: 'create_spreadsheet', sourceScope: 'workspace', destination: 'output/reports/table.csv', rows: [['姓名', '备注'], ['张三', '有,逗号']], selectors: {} }, { roots: [desktop] })
      expect(await readFile(sheet.files[0].path, 'utf8')).toContain('"有,逗号"')
      await access(path.join(workspace, 'input', '说明.md'))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
