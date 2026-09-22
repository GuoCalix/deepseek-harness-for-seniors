// Adapted from the pinned DeepSeek Harness account provider. See docs/OPERATIONS.md.
import crypto from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { readJson, writeJson } from './storage.mjs'
import { origin, requestJson } from './network.mjs'

const activePhases = ['initializing', 'waiting-browser', 'exchanging', 'committing']
const decimal = value => typeof value === 'string' && /^-?\d+(?:\.\d+)?$/u.test(value)
function wallets(value) {
  if (!Array.isArray(value) || value.some(item => !item || !['CNY', 'USD'].includes(item.currency) || !decimal(item.balance))) throw new Error('DeepSeek wallet response is invalid')
  return value.map(({ currency, balance }) => ({ currency, balance }))
}
export function apiBalance(value) {
  if (typeof value?.is_available !== 'boolean' || !Array.isArray(value.balance_infos)) throw new Error('DeepSeek balance response is invalid')
  return { available: value.is_available, infos: value.balance_infos.map(item => {
    if (!['CNY', 'USD'].includes(item?.currency) || ![item.total_balance, item.granted_balance, item.topped_up_balance].every(decimal)) throw new Error('DeepSeek balance response is invalid')
    return { currency: item.currency, totalBalance: item.total_balance, grantedBalance: item.granted_balance, toppedUpBalance: item.topped_up_balance }
  }) }
}

export function createAccountService({ store, dataDir, callbackOrigin, platformOrigin: platform, inferenceOrigin: inference, apiKey = '', attemptTimeoutMs = 600_000 }) {
  platform = origin(platform, 'https://platform.deepseek.com')
  inference = origin(inference, 'https://api.deepseek.com')
  const clientHeaders = process.platform === 'darwin' ? { 'x-client-platform': 'desktop-mac' } : process.platform === 'win32' ? { 'x-client-platform': 'desktop-win' } : {}
  let record = {}
  let attempt
  let generation = 0
  let operations = Promise.resolve()
  let details = { profile: null, balance: null, apiBalance: null, balanceError: null, balanceUpdatedAt: null }
  let detailsAt = 0
  let refreshing
  const ready = (async () => {
    record = await store.read()
    if (record.account && (record.account.issuer !== platform || typeof record.account.token !== 'string' || !/^[\x21-\x7e]+$/.test(record.account.token))) {
      record = { ...record, account: null }
      await store.write(record)
    }
  })()
  // Loading can fail before the renderer makes its first request. Preserve the
  // rejection for callers without letting Node terminate the desktop process.
  void ready.catch(() => undefined)
  function enqueue(operation) {
    const next = operations.then(operation)
    operations = next.catch(() => undefined)
    return next
  }
  function invalidate() {
    generation += 1
    detailsAt = 0
    refreshing = undefined
    details = { profile: null, balance: null, apiBalance: null, balanceError: null, balanceUpdatedAt: null }
  }
  async function platformRequest(endpoint, body, token, signal) {
    const value = await requestJson(`${platform}${endpoint}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...clientHeaders, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { 'x-dsh-auth-token': token } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal,
    })
    if (value?.code !== 0 || value?.data?.biz_code !== 0) throw new Error('DeepSeek account authorization was rejected; retry on the official page')
    return value.data.biz_data
  }
  function browserUrl(value, pathname) {
    const url = new URL(value)
    if (url.origin !== platform || url.pathname !== pathname || url.username || url.password || url.hash) throw new Error('DeepSeek returned an invalid authorization address')
    return url
  }
  function view() {
    return {
      status: record.account ? 'credential-stored' : 'signed-out',
      attempt: attempt ? { id: attempt.id, phase: attempt.phase, ...(attempt.phase === 'waiting-browser' ? { authorizeUrl: attempt.authorizeUrl } : {}), expiresAt: attempt.expiresAt, ...(attempt.errorCode ? { errorCode: attempt.errorCode } : {}) } : null,
      links: { usageUrl: `${platform}/usage`, topUpUrl: `${platform}/top_up` },
    }
  }
  function finish(current, phase) {
    clearTimeout(current.timer)
    current.phase = phase
    delete current.authorizeUrl
  }
  function cancel(current, phase = 'cancelled') {
    if (!current || !activePhases.includes(current.phase) || current.phase === 'committing') return
    finish(current, phase)
    current.controller.abort()
    if (current.authorizeId) void platformRequest('/auth-api/v0/dsh/auth_cancel', { authorize_id: current.authorizeId, code_verifier: current.verifier }).catch(() => undefined)
  }
  async function credential() {
    await ready
    if (record.account) {
      if (inference === 'https://api.deepseek.com' && (platform !== 'https://platform.deepseek.com' || record.account.token.startsWith('dsh_mock_'))) throw new Error('DeepSeek development credentials cannot authenticate the production API')
      return { mode: 'account', token: record.account.token }
    }
    const key = record.apiKey || apiKey
    return key ? { mode: 'api_key', token: key } : { mode: 'none' }
  }
  async function refresh(force) {
    await ready
    if (refreshing) return refreshing
    if (!force && Date.now() - detailsAt < 20_000) return
    const lifetime = generation
    const snapshot = record
    const operation = (async () => {
      try {
        if (snapshot.account) {
          const [profile, balance] = await Promise.allSettled([
            platformRequest('/auth-api/v0/users/current', undefined, snapshot.account.token),
            platformRequest('/api/v0/users/get_user_summary', undefined, snapshot.account.token).then(value => ({ normalWallets: wallets(value?.normal_wallets), bonusWallets: wallets(value?.bonus_wallets) })),
          ])
          if (lifetime !== generation) return
          if (profile.status === 'fulfilled') {
            const p = profile.value
            details.profile = { name: typeof p?.id_profile?.name === 'string' ? p.id_profile.name : null, contact: typeof p?.mobile === 'string' ? p.mobile : typeof p?.mobile_number === 'string' ? p.mobile_number : typeof p?.email === 'string' ? p.email : null }
          }
          if (balance.status === 'fulfilled') { details.balance = balance.value; details.balanceError = null; details.balanceUpdatedAt = new Date().toISOString() }
          else details.balanceError = 'refresh_failed'
        } else if (snapshot.apiKey || apiKey) {
          const value = apiBalance(await requestJson(`${inference}/user/balance`, { headers: { authorization: `Bearer ${snapshot.apiKey || apiKey}` } }))
          if (lifetime !== generation) return
          details.apiBalance = value; details.balanceError = null; details.balanceUpdatedAt = new Date().toISOString()
        }
      } catch {
        if (lifetime === generation) details.balanceError = 'refresh_failed'
      } finally { if (lifetime === generation) detailsAt = Date.now() }
    })()
    refreshing = operation
    try { await operation } finally { if (refreshing === operation) refreshing = undefined }
  }
  return {
    credential,
    async status(refreshDetails = false) {
      await ready
      if (refreshDetails) await refresh(true)
      const mode = record.account ? 'account' : record.apiKey || apiKey ? 'api_key' : 'none'
      return { provider: 'DeepSeek', apiConfigured: Boolean(record.apiKey || apiKey), authMode: mode, persistentCredentials: store.persistent, account: view(), ...details }
    },
    async start(locale = 'zh') {
      await ready
      await operations
      if (attempt && activePhases.includes(attempt.phase)) {
        await attempt.initialization
        return { account: view(), authorizeUrl: attempt.authorizeUrl }
      }
      const current = { id: crypto.randomUUID(), phase: 'initializing', controller: new AbortController(), verifier: crypto.randomBytes(32).toString('base64url'), state: crypto.randomBytes(32).toString('base64url'), expiresAt: Date.now() + attemptTimeoutMs }
      attempt = current
      const redirect = new URL('/oauth/callback', callbackOrigin())
      if (redirect.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(redirect.hostname) || !redirect.port) throw new Error('Invalid loopback callback origin')
      current.redirectUri = redirect.href
      const expire = () => cancel(current, 'expired')
      current.timer = setTimeout(expire, attemptTimeoutMs)
      current.timer.unref?.()
      current.initialization = (async () => {
        try {
          const value = await platformRequest('/auth-api/v0/dsh/auth_init', { code_challenge: crypto.createHash('sha256').update(current.verifier).digest('base64url'), code_challenge_method: 'S256', state: current.state, redirect_uri: current.redirectUri, locale: locale === 'en' ? 'en_US' : 'zh_CN', login_source: 'desktop' }, undefined, current.controller.signal)
          if (current.controller.signal.aborted) return
          if (typeof value?.authorize_id !== 'string' || !value.authorize_id || !Number.isFinite(value.expires_in) || value.expires_in <= 0) throw new Error('DeepSeek authorization response is incomplete')
          current.authorizeUrl = browserUrl(value.authorize_url, '/dsh/authorize').href
          current.authorizeId = value.authorize_id
          current.expiresAt = Math.min(current.expiresAt, Date.now() + value.expires_in * 1000)
          clearTimeout(current.timer)
          current.timer = setTimeout(expire, Math.max(1, current.expiresAt - Date.now()))
          current.timer.unref?.()
          current.phase = 'waiting-browser'
        } catch (error) {
          if (!current.controller.signal.aborted) { finish(current, 'failed'); current.errorCode = 'authorization_failed'; throw error }
        }
      })()
      await current.initialization
      return { account: view(), authorizeUrl: current.authorizeUrl }
    },
    async callback(url) {
      await ready
      const current = attempt
      if (!current || current.phase !== 'waiting-browser') return { status: 410 }
      if (Date.now() >= current.expiresAt) { cancel(current, 'expired'); return { status: 410 } }
      const state = Buffer.from(url.searchParams.get('state') ?? '')
      const expected = Buffer.from(current.state)
      const code = url.searchParams.get('code')
      if (url.searchParams.getAll('state').length !== 1 || url.searchParams.getAll('code').length !== 1 || !code || code.length > 4096 || state.length !== expected.length || !crypto.timingSafeEqual(state, expected)) return { status: 400 }
      current.phase = 'exchanging' // Consume before any await: duplicates can never exchange again.
      let grant
      try {
        const deviceFile = path.join(dataDir, 'device.json')
        let device = await readJson(deviceFile)
        if (!device?.id) { device = { id: crypto.randomUUID() }; await writeJson(deviceFile, device) }
        const value = await platformRequest('/auth-api/v0/dsh/auth_exchange', { code, code_verifier: current.verifier, redirect_uri: current.redirectUri, device_id: device.id, device_model: `${process.platform}-${process.arch}`, os_version: `${process.platform} ${os.release()}` }, undefined, current.controller.signal)
        if (typeof value?.token !== 'string' || !/^[\x21-\x7e]+$/.test(value.token)) throw new Error('DeepSeek grant is invalid')
        grant = { version: 1, token: value.token, issuer: platform }
        const completion = browserUrl(value.authorized_url, '/dsh/authorized')
        completion.searchParams.set('login_source', 'desktop')
        const committed = await enqueue(async () => {
          if (current.controller.signal.aborted || attempt !== current) return false
          current.phase = 'committing'
          clearTimeout(current.timer)
          const next = { ...record, account: grant }
          await store.write(next)
          record = next
          invalidate()
          finish(current, 'succeeded')
          return true
        })
        if (!committed) { void platformRequest('/auth-api/v0/users/logout', {}, grant.token).catch(() => undefined); return { status: 410 } }
        return { status: 302, location: completion.href }
      } catch {
        if (grant && current.phase !== 'succeeded') void platformRequest('/auth-api/v0/users/logout', {}, grant.token).catch(() => undefined)
        if (!current.controller.signal.aborted) { finish(current, 'failed'); current.errorCode = 'exchange_failed' }
        return { status: current.controller.signal.aborted ? 410 : 502 }
      }
    },
    async cancel() { await ready; cancel(attempt); await operations; return this.status() },
    async logout() {
      await ready
      cancel(attempt)
      invalidate()
      await enqueue(async () => {
        const previous = record.account
        const next = { ...record, account: null }
        await store.write(next)
        record = next
        attempt = undefined
        invalidate()
        if (previous) void platformRequest('/auth-api/v0/users/logout', {}, previous.token).catch(() => undefined)
      })
      return this.status()
    },
    async setApiKey(key) {
      await ready
      if (typeof key !== 'string' || !/^sk-[a-zA-Z0-9_-]{16,200}$/.test(key)) throw new Error('DeepSeek API key format is invalid')
      const balance = apiBalance(await requestJson(`${inference}/user/balance`, { headers: { authorization: `Bearer ${key}` } }))
      await enqueue(async () => { const next = { ...record, apiKey: key }; await store.write(next); record = next; invalidate(); details.apiBalance = balance; details.balanceUpdatedAt = new Date().toISOString() })
      return this.status()
    },
    async removeApiKey() { await ready; await enqueue(async () => { const next = { ...record, apiKey: null }; await store.write(next); record = next; invalidate() }); return this.status() },
    dispose() { cancel(attempt) },
  }
}
