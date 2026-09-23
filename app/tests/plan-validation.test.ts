import { describe, expect, it } from 'vitest'
import { validatePlan } from '../server/index.mjs'

describe('DeepSeek clarification response validation', () => {
  it('allows a follow-up question without an executable target', () => {
    expect(validatePlan({ next_action: 'ask_question', question: '需要处理哪个月份的文件？' })).toMatchObject({
      nextAction: 'ask_question',
      question: '需要处理哪个月份的文件？',
      target: '',
      output: '',
      network: '',
      summary: '需要处理哪个月份的文件？',
    })
  })

  it('still requires the complete preview when ready to run', () => {
    expect(() => validatePlan({ next_action: 'ready_to_run', question: '' })).toThrow('任务目标')
    expect(validatePlan({ next_action: 'ready_to_run', question: '', target: '整理文件', output: 'Markdown 报告', network: '不联网', summary: '整理文件并生成报告' })).toMatchObject({ nextAction: 'ready_to_run', target: '整理文件' })
  })
})
