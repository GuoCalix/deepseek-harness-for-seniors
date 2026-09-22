import { useEffect, useState } from 'react'
import { Check, ExternalLink, LoaderCircle, LockKeyhole, WalletCards } from 'lucide-react'
import { api, openDeepSeek, type AccountStatus } from './api'
import type { Locale } from './i18n'

const changed = () => window.dispatchEvent(new Event('account-updated'))
export function useAccount() {
  const [status, setStatus] = useState<AccountStatus | null>(null)
  const [error, setError] = useState('')
  async function load(refresh = false) {
    try { const value = await (refresh ? api.refreshAccountStatus() : api.accountStatus()); setStatus(value); setError('') }
    catch (e) { setError(e instanceof Error ? e.message : 'Account unavailable') }
  }
  useEffect(() => {
    let active = true
    let pending = false
    const loadState = async () => {
      if (pending) return
      pending = true
      try { const value = await api.accountStatus(); if (active) { setStatus(value); setError('') } }
      catch (e) { if (active) setError(e instanceof Error ? e.message : 'Account unavailable') }
      finally { pending = false }
    }
    loadState()
    const timer = setInterval(loadState, 2000)
    const refresh = () => { void load(true) }
    window.addEventListener('account-updated', refresh)
    return () => { active = false; clearInterval(timer); window.removeEventListener('account-updated', refresh) }
  }, [])
  return { status, error, load }
}

export function AccountPanel({ locale, onLogin }: { locale: Locale; onLogin: () => void }) {
  const zh = locale === 'zh'
  const { status, error, load } = useAccount()
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    void load(true)
    const refresh = () => { void load(true) }
    const timer = setInterval(refresh, 30_000)
    window.addEventListener('focus', refresh)
    return () => { clearInterval(timer); window.removeEventListener('focus', refresh) }
  }, [])
  const rows = status?.authMode === 'account'
    ? [...new Set([...(status.balance?.normalWallets ?? []), ...(status.balance?.bonusWallets ?? [])].map(wallet => wallet.currency))].map(currency => ({ currency, total: null, topUp: status.balance?.normalWallets.find(item => item.currency === currency)?.balance ?? null, bonus: status.balance?.bonusWallets.find(item => item.currency === currency)?.balance ?? null }))
    : status?.apiBalance?.infos.map(wallet => ({ currency: wallet.currency, total: wallet.totalBalance, topUp: wallet.toppedUpBalance, bonus: wallet.grantedBalance })) ?? []
  async function refresh() { setBusy(true); try { await load(true) } finally { setBusy(false) } }
  const billingUrl = status?.account.links.topUpUrl ?? 'https://platform.deepseek.com/top_up'
  return <div className="page-view">
    <div className="page-title"><span className="page-title-icon"><WalletCards /></span><div><h1>{zh ? '账户与充值' : 'Account & billing'}</h1><p>{status?.authMode === 'none' ? (zh ? '连接账号后开始使用' : 'Connect an account to get started') : status?.profile?.name ?? (status?.authMode === 'api_key' ? 'DeepSeek API key' : 'DeepSeek')}</p></div></div>
    {(error || status?.balanceError) && <p role="alert" className="account-error">{error || (zh ? '余额刷新失败。下方如有数值，为上次查询结果；请重试。' : 'Balance refresh failed. Any value below is from the last successful query. Please retry.')}</p>}
    <div className="balance-grid">
      <section className="balance-card dark"><div className="balance-card-top"><span>{zh ? '官方余额' : 'Official balance'}</span><WalletCards size={21} /></div>
        {rows.length ? rows.map(row => <div key={row.currency}><strong>{row.total ?? row.topUp ?? '—'} <span className="currency-label">{row.currency}</span></strong><p>{row.total ? (zh ? '总可用余额' : 'Total available') : (zh ? '充值余额' : 'Top-up balance')}</p><small>{zh ? '充值' : 'Top-up'}: {row.topUp ?? '—'} · {zh ? '赠送' : 'Granted'}: {row.bonus ?? '—'}</small></div>) : <strong>—</strong>}
        <small>{status?.balanceUpdatedAt ? `${zh ? '查询时间' : 'Queried'} ${new Date(status.balanceUpdatedAt).toLocaleTimeString()}` : zh ? '尚无已验证的余额' : 'No verified balance yet'}</small>
        <button className="light-button" onClick={refresh} disabled={busy}>{busy ? <LoaderCircle className="spin" size={16} /> : null}{zh ? '刷新余额' : 'Refresh balance'}</button>
      </section>
      <section className="balance-card"><div className="balance-card-top"><span>{zh ? '本应用本月用量（UTC）' : 'This app this month (UTC)'}</span></div><strong>{status?.usage.totalTokens.toLocaleString() ?? '—'}</strong><p>tokens · {status?.usage.requests ?? 0} {zh ? '次调用' : 'requests'}</p><small>{zh ? '输入' : 'Input'} {status?.usage.inputTokens ?? 0} · {zh ? '输出' : 'Output'} {status?.usage.outputTokens ?? 0}</small><p>{status?.usage.estimatedRequests ? `${status.usage.estimatedRequests} ${zh ? '次缺少官方用量，已标记为估算' : 'requests estimated because provider usage was missing'}` : zh ? '根据 API 返回的用量累计，不推算余额或账单' : 'Accumulated from API usage; not a balance or bill estimate'}</p>{status?.usage.warning && <p role="alert">{zh ? '最近用量无法保存，统计可能不完整。' : 'Recent usage could not be saved; totals may be incomplete.'}</p>}</section>
    </div>
    <section className="account-section"><div className="section-heading"><div><h2>{zh ? '连接方式' : 'Connection'}</h2><p>{status?.authMode === 'account' ? (zh ? '已通过官方账号授权' : 'Official account authorized') : status?.authMode === 'api_key' ? (zh ? '使用已连接的 API key' : 'Using a connected API key') : (zh ? '尚未连接 DeepSeek' : 'DeepSeek is not connected')}</p></div><button className="primary-button" onClick={onLogin}><LockKeyhole size={18} />{zh ? '管理连接' : 'Manage connection'}</button></div></section>
    <section className="account-section"><h2>{zh ? '充值与账单' : 'Credit & bills'}</h2><p>{zh ? '在 DeepSeek 官方页面选择金额、扫码支付并查看订单。付款后回到此处刷新余额。' : 'Choose an amount, pay and view orders on the official DeepSeek page. Return here to refresh your balance.'}</p><div className="account-actions"><a className="primary-button" href={billingUrl} target="_blank" rel="noreferrer" onClick={e => { if (window.desktop) { e.preventDefault(); void openDeepSeek(billingUrl) } }}><ExternalLink size={18} />{zh ? '打开官方充值' : 'Open official top-up'}</a><a className="secondary-button" href="https://platform.deepseek.com/usage" target="_blank" rel="noreferrer" onClick={e => { if (window.desktop) { e.preventDefault(); void openDeepSeek('https://platform.deepseek.com/usage') } }}>{zh ? '查看官方用量' : 'View official usage'}</a></div></section>
  </div>
}

export function LoginContent({ locale, onDone }: { locale: Locale; onDone: () => void }) {
  const zh = locale === 'zh'
  const { status, load, error: statusError } = useAccount()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [key, setKey] = useState('')
  const [keyMode, setKeyMode] = useState(false)
  const current = status?.account.attempt
  const active = ['initializing', 'waiting-browser', 'exchanging', 'committing'].includes(current?.phase ?? '')
  const signedIn = status?.authMode === 'account'
  async function action(fn: () => Promise<unknown>) { setBusy(true); setError(''); try { await fn(); await load(); changed() } catch (e) { setError(e instanceof Error ? e.message : 'Connection failed') } finally { setBusy(false) } }
  return <div className="login-modal"><LockKeyhole size={36} /><h3>{signedIn ? (zh ? '账号已授权' : 'Account authorized') : (zh ? '连接你的 DeepSeek' : 'Connect your DeepSeek')}</h3><p>{zh ? '在电脑的官方授权页使用微信扫码或手机号登录。确认后，本应用会自动接入账号。' : 'Use WeChat QR or phone sign-in on the official page on this computer. Authorization connects your account automatically.'}</p>
    {(error || statusError) && <p className="account-error" role="alert">{error || statusError}</p>}
    {!status && <p role="status">{zh ? '正在读取系统安全存储。如 macOS 提示，请解锁钥匙串并授权。' : 'Reading system secure storage. Unlock and approve Keychain if macOS asks.'}</p>}
    {!signedIn && !active && <button className="primary-button full-button" disabled={busy} onClick={() => action(async () => { const result = await api.startAccountLogin(locale); if (result.authorizeUrl && window.desktop) await openDeepSeek(result.authorizeUrl) })}>{busy ? <LoaderCircle className="spin" size={18} /> : <ExternalLink size={18} />}{zh ? '打开官方账号授权' : 'Authorize with DeepSeek'}</button>}
    {current?.authorizeUrl && <a className="secondary-button full-button" href={current.authorizeUrl} target="_blank" rel="noreferrer" onClick={e => { if (window.desktop) { e.preventDefault(); void openDeepSeek(current.authorizeUrl!) } }}>{zh ? '继续打开授权页' : 'Continue to authorization'}</a>}
    {active && <><p role="status">{zh ? '等待你在官方页面完成确认…' : 'Waiting for confirmation on the official page…'}</p><button className="secondary-button full-button" disabled={busy} onClick={() => action(api.cancelAccountLogin)}>{zh ? '取消此次登录' : 'Cancel sign-in'}</button></>}
    {['expired', 'failed', 'cancelled'].includes(current?.phase ?? '') && <p role="status">{zh ? '此次登录未完成，可以重新连接。' : 'Sign-in did not complete. You can try again.'}</p>}
    {signedIn && <><button className="primary-button full-button" onClick={onDone}><Check size={18} />{zh ? '开始使用' : 'Continue'}</button><button className="secondary-button full-button" disabled={busy} onClick={() => action(api.logoutAccount)}>{zh ? '退出账号' : 'Sign out'}</button></>}
    <button className="text-button" onClick={() => setKeyMode(!keyMode)}>{zh ? '使用已有 API key' : 'Use an existing API key'}</button>
    {keyMode && <form className="api-key-form" onSubmit={e => { e.preventDefault(); const submitted = key; setKey(''); void action(() => api.connectApiKey(submitted)) }}><label htmlFor="api-key">DeepSeek API key</label><input id="api-key" type="password" autoComplete="off" spellCheck={false} value={key} onChange={e => setKey(e.target.value)} placeholder="sk-…" /><p>{window.desktop ? (zh ? '验证成功后由系统安全存储保护。' : 'Protected by system secure storage after validation.') : (zh ? '开发网页只在服务内存中保留，重启后需要重新连接。' : 'The development server keeps this in memory until restart.')}</p><button className="primary-button full-button" disabled={busy || !key.trim()} type="submit">{zh ? '验证并连接' : 'Verify and connect'}</button>{status?.apiConfigured && <button className="secondary-button full-button" type="button" onClick={() => action(api.removeApiKey)}>{zh ? '移除已保存的 key' : 'Remove saved key'}</button>}</form>}
  </div>
}
