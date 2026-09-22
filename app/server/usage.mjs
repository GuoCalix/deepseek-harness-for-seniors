import path from 'node:path'
import { readJson, writeJson } from './storage.mjs'

const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0
export function normalizeUsage(value, messagesProtocol = false) {
  const cacheReadTokens = count(value?.cache_read_input_tokens ?? value?.prompt_cache_hit_tokens)
  const cacheWriteTokens = count(value?.cache_creation_input_tokens)
  const inputTokens = count(value?.prompt_tokens ?? value?.input_tokens) + (messagesProtocol ? cacheReadTokens + cacheWriteTokens : 0)
  const outputTokens = count(value?.completion_tokens ?? value?.output_tokens)
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, cacheReadTokens, cacheWriteTokens }
}

export function usageStore(directory) {
  const file = path.join(directory, 'usage.json')
  let queue = Promise.resolve()
  let warning = false
  async function read() {
    const month = new Date().toISOString().slice(0, 7)
    const value = await readJson(file, {})
    const result = { month, requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedRequests: 0, updatedAt: null, warning }
    if (value.month === month) {
      for (const field of ['requests', 'inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'estimatedRequests']) result[field] = count(value[field])
      result.updatedAt = typeof value.updatedAt === 'string' ? value.updatedAt : null
    }
    return result
  }
  return {
    read,
    record(usage, estimated, messagesProtocol) {
      const operation = queue.then(async () => {
        const current = await read()
        const normalized = normalizeUsage(usage, messagesProtocol)
        for (const field of Object.keys(normalized)) current[field] += normalized[field]
        current.requests += 1
        current.estimatedRequests += Number(estimated)
        current.updatedAt = new Date().toISOString()
        await writeJson(file, current)
        warning = false
      })
      queue = operation.catch(() => { warning = true })
      return queue
    },
  }
}
