export function origin(value, official) {
  const url = new URL(value ?? official)
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || !(url.protocol === 'https:' || loopback && url.protocol === 'http:')) throw new Error('Provider origin must be HTTPS or loopback HTTP')
  return url.origin
}

export async function requestJson(url, init = {}, limit = 65_536) {
  const signal = init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000)
  let response
  try { response = await fetch(url, { ...init, redirect: 'error', signal }) }
  catch { throw new Error('DeepSeek network request failed; check the connection and retry') }
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`DeepSeek request failed (HTTP ${response.status})`)
  }
  if (!response.body) throw new Error('DeepSeek returned an empty response')
  const reader = response.body.getReader()
  const chunks = []
  let bytes = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > limit) throw new Error('DeepSeek response exceeds the size limit')
      chunks.push(value)
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
    catch { throw new Error('DeepSeek returned an invalid JSON response') }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
}
