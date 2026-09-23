import type { Candidate, Preview, Task } from './types'

export interface AccountWallet { currency: 'CNY' | 'USD'; balance: string }
export interface AccountStatus {
  provider: string
  apiConfigured: boolean
  authMode: 'account' | 'api_key' | 'none'
  account: { status: 'signed-out' | 'credential-stored'; attempt: { id: string; phase: string; authorizeUrl?: string; expiresAt?: number; errorCode?: string } | null; links: { usageUrl: string; topUpUrl: string } }
  profile: { name: string | null; contact: string | null } | null
  balance: { normalWallets: AccountWallet[]; bonusWallets: AccountWallet[] } | null
  apiBalance: { available: boolean; infos: { currency: 'CNY' | 'USD'; totalBalance: string; grantedBalance: string | null; toppedUpBalance: string | null }[] } | null
  usage: { requests: number; inputTokens: number; outputTokens: number; totalTokens: number; estimatedRequests: number; updatedAt: string | null; warning: boolean }
  balanceError: string | null
  balanceUpdatedAt: string | null
  persistentCredentials: boolean
}

declare global {
  interface Window {
    desktop?: {
      request(method: string, path: string, body: string): Promise<{ status: number; body: string }>
      openDeepSeek(url: string): Promise<void>
      openPath(path: string): Promise<void>
    }
  }
}

export function openDeepSeek(url: string) {
  if (window.desktop) return window.desktop.openDeepSeek(url)
  window.open(url, '_blank', 'noopener,noreferrer')
  return Promise.resolve()
}

export function openLocalPath(path: string) {
  if (window.desktop) return window.desktop.openPath(path)
  return Promise.resolve()
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  if (window.desktop) {
    const response = await window.desktop.request(options?.method ?? 'GET', path, String(options?.body ?? ''))
    const body = JSON.parse(response.body) as T & { message?: string }
    if (response.status >= 400) throw new Error(body.message ?? 'Local service unavailable')
    return body
  }
  const response = await fetch(path, { ...options, headers: { 'content-type': 'application/json', ...(options?.headers ?? {}) } })
  const body = await response.json() as T & { message?: string }
  if (!response.ok) throw new Error(body.message ?? '本地服务暂时不可用')
  return body
}

export const api = {
  listTasks: () => request<Task[]>('/api/tasks'),
  accountStatus: () => request<AccountStatus>('/api/account/status'),
  refreshAccountStatus: () => request<AccountStatus>('/api/account/status?refresh=1'),
  startAccountLogin: (locale: 'zh' | 'en') => request<{ account: AccountStatus['account']; authorizeUrl?: string }>('/api/account/login/start', { method: 'POST', body: JSON.stringify({ locale }) }),
  logoutAccount: () => request<AccountStatus>('/api/account/logout', { method: 'POST', body: '{}' }),
  cancelAccountLogin: () => request<AccountStatus>('/api/account/login/cancel', { method: 'POST', body: '{}' }),
  connectApiKey: (key: string) => request<AccountStatus>('/api/account/key', { method: 'POST', body: JSON.stringify({ key }) }),
  removeApiKey: () => request<AccountStatus>('/api/account/key/remove', { method: 'POST', body: '{}' }),
  createTask: (prompt: string, locale: 'zh' | 'en') => request<{ task: Task; candidates: Candidate[] }>('/api/tasks', { method: 'POST', body: JSON.stringify({ prompt, locale }) }),
  clarify: (taskId: string, content: string, locale: 'zh' | 'en') => request<{ task: Task; preview: Preview | null; question?: string }>(`/api/tasks/${taskId}/clarifications`, { method: 'POST', body: JSON.stringify({ content, locale }) }),
  approveAccess: (taskId: string, roots: string[], network: boolean) => request<Task>(`/api/tasks/${taskId}/access-scope`, { method: 'POST', body: JSON.stringify({ roots, network }) }),
  run: (taskId: string, roots: string[], network: boolean) => request<Task>(`/api/tasks/${taskId}/run`, { method: 'POST', body: JSON.stringify({ roots, network }) }),
  pause: (taskId: string) => request<Task>(`/api/tasks/${taskId}/pause`, { method: 'POST', body: '{}' }),
  resume: (taskId: string) => request<Task>(`/api/tasks/${taskId}/resume`, { method: 'POST', body: '{}' }),
  cancel: (taskId: string) => request<Task>(`/api/tasks/${taskId}/cancel`, { method: 'POST', body: '{}' }),
  feedback: (taskId: string, category: string, comment: string, good: boolean) => request<Task>(`/api/tasks/${taskId}/feedback`, { method: 'POST', body: JSON.stringify({ category, comment, good }) }),
}
