import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAccountService, apiBalance } from '../server/account.mjs'
import { usageStore, normalizeUsage } from '../server/usage.mjs'

let directory: string
let server: ReturnType<typeof createServer>
let service: ReturnType<typeof createAccountService>
let platform: string
let init: any
let exchange: any
let exchangeCount: number
let balanceFails: boolean
let released: (() => void) | undefined
let exchangeGate: Promise<void> | undefined
let stored: any
let ttl = 600
let requests: string[]

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'ai-old-account-test-'))
  stored = {}; init = null; exchange = null; exchangeCount = 0; balanceFails = false; ttl = 600; exchangeGate = undefined; requests = []
  server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}
    requests.push(req.url!)
    let payload: any = {}
    if (req.url?.endsWith('auth_init')) { init = body; payload = { authorize_url: `${platform}/dsh/authorize?id=fixture`, authorize_id: 'fixture', expires_in: ttl } }
    if (req.url?.endsWith('auth_exchange')) { exchange = body; exchangeCount++; if (exchangeGate) await exchangeGate; payload = { token: 'test-account-grant', authorized_url: `${platform}/dsh/authorized` } }
    if (req.url?.endsWith('current')) payload = { email: 'masked@example.test', id_profile: { name: 'Fixture user' } }
    if (req.url?.endsWith('get_user_summary')) {
      if (balanceFails) { res.writeHead(503).end(); return }
      payload = { normal_wallets: [{ currency: 'CNY', balance: '9.99' }], bonus_wallets: [{ currency: 'CNY', balance: '0.10' }] }
    }
    if (req.url === '/user/balance') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '10.09', granted_balance: '0.10', topped_up_balance: '9.99' }] })); return }
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ code: 0, data: { biz_code: 0, biz_data: payload } }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  platform = `http://127.0.0.1:${(server.address() as any).port}`
  service = createAccountService({ dataDir: directory, store: { read: async () => stored, write: async (value: any) => { stored = value }, persistent: true }, callbackOrigin: () => 'http://127.0.0.1:4199', platformOrigin: platform, inferenceOrigin: platform })
})
afterEach(async () => {
  released?.(); released = undefined
  service.dispose()
  server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => resolve()))
  await rm(directory, { recursive: true, force: true })
})
const callback = (state = init.state) => new URL(`http://127.0.0.1:4199/oauth/callback?code=single-use&state=${encodeURIComponent(state)}`)

describe('DeepSeek account protocol', () => {
  it('uses PKCE once, projects only safe fields, and keeps official balances separate', async () => {
    const result = await service.start('en')
    expect(init.locale).toBe('en_US')
    expect(JSON.stringify(result)).not.toContain(init.state)
    expect(result.account.attempt).not.toHaveProperty('verifier')
    expect((await service.callback(callback())).status).toBe(302)
    expect(createHash('sha256').update(exchange.code_verifier).digest('base64url')).toBe(init.code_challenge)
    expect(exchange.redirect_uri).toBe(init.redirect_uri)
    expect((await service.callback(callback())).status).toBe(410)
    expect(exchangeCount).toBe(1)
    const status = await service.status(true)
    expect(status.balance.normalWallets[0].balance).toBe('9.99')
    expect(status.balance.bonusWallets[0].balance).toBe('0.10')
    expect(JSON.stringify(status)).not.toContain('test-account-grant')
    expect(await service.credential()).toMatchObject({ mode: 'account' })
  })
  it('rejects malformed, duplicate and multibyte state without consuming the valid attempt', async () => {
    await service.start()
    expect((await service.callback(callback('错'.repeat(init.state.length)))).status).toBe(400)
    const duplicate = callback(); duplicate.searchParams.append('state', init.state)
    expect((await service.callback(duplicate)).status).toBe(400)
    expect((await service.callback(callback())).status).toBe(302)
  })
  it('serializes concurrent starts and refuses callbacks during an exchange', async () => {
    await Promise.all([service.start(), service.start()])
    expect(requests.filter(p => p.endsWith('auth_init'))).toHaveLength(1)
    exchangeGate = new Promise<void>(resolve => { released = resolve })
    const pending = service.callback(callback())
    await new Promise(resolve => setTimeout(resolve, 20))
    expect((await service.callback(callback())).status).toBe(410)
    released!()
    expect((await pending).status).toBe(302)
  })
  it('logout prevents late exchange responses from signing back in', async () => {
    await service.start()
    exchangeGate = new Promise<void>(resolve => { released = resolve })
    const pending = service.callback(callback())
    await new Promise(resolve => setTimeout(resolve, 20))
    await service.logout()
    released!()
    expect((await pending).status).toBe(410)
    expect((await service.status()).authMode).toBe('none')
    expect(stored.account).toBeNull()
  })
  it('cancels and expires attempts, then permits a fresh start', async () => {
    await service.start()
    await service.cancel()
    expect((await service.callback(callback())).status).toBe(410)
    ttl = 0.015
    await service.start()
    await new Promise(resolve => setTimeout(resolve, 30))
    expect((await service.status()).account.attempt.phase).toBe('expired')
    ttl = 600
    expect((await service.start()).account.attempt.phase).toBe('waiting-browser')
  })
  it('retains the last balance with a stale marker when the provider fails', async () => {
    await service.start(); await service.callback(callback())
    await service.status(true)
    balanceFails = true
    const status = await service.status(true)
    expect(status.balance.normalWallets[0].balance).toBe('9.99')
    expect(status.balanceError).toBe('refresh_failed')
    const before = requests.length
    await service.status()
    expect(requests).toHaveLength(before)
  })
  it('discards a foreign issuer without sending its token anywhere', async () => {
    service.dispose()
    stored = { account: { issuer: 'https://foreign.example', token: 'foreign-grant' } }
    service = createAccountService({ dataDir: directory, store: { read: async () => stored, write: async (v: any) => { stored = v } }, callbackOrigin: () => 'http://127.0.0.1:4199', platformOrigin: platform })
    expect((await service.status(true)).authMode).toBe('none')
    expect(requests).toHaveLength(0)
  })
  it('verifies API keys with the official balance contract and never projects the key', async () => {
    const status = await service.setApiKey('sk-fixture00000000000000000000')
    expect(status.authMode).toBe('api_key')
    expect(status.apiBalance.infos[0].totalBalance).toBe('10.09')
    expect(JSON.stringify(status)).not.toContain('sk-fixture')
    expect(() => apiBalance({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: 'NaN' }] })).toThrow()
  })
})

it('serializes concurrent usage writes and includes Messages cache tokens exactly once', async () => {
  const meter = usageStore(directory)
  await Promise.all(Array.from({ length: 20 }, () => meter.record({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 }, false, true)))
  expect(await meter.read()).toMatchObject({ requests: 20, totalTokens: 400, inputTokens: 300, outputTokens: 100, estimatedRequests: 0 })
  expect(normalizeUsage({ prompt_tokens: 15, completion_tokens: 5, prompt_cache_hit_tokens: 3 })).toMatchObject({ totalTokens: 20 })
  expect(normalizeUsage({ input_tokens: -3, output_tokens: Infinity })).toMatchObject({ totalTokens: 0 })
})
