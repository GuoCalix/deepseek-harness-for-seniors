import type { Candidate, Preview, Task } from './types'

export interface AccountStatus { provider: string; apiConfigured: boolean; webLoginTransfer: boolean; balance: number | null; billing: string }

const API_BASE = window.location.protocol === 'file:' ? 'http://127.0.0.1:4179' : ''

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, { headers: { 'content-type': 'application/json', ...(options?.headers ?? {}) }, ...options })
  const body = await response.json() as T & { message?: string }
  if (!response.ok) throw new Error(body.message ?? '本地服务暂时不可用')
  return body
}

export const api = {
  listTasks: () => request<Task[]>('/api/tasks'),
  accountStatus: () => request<AccountStatus>('/api/account/status'),
  createTask: (prompt: string, locale: 'zh' | 'en') => request<{ task: Task; candidates: Candidate[] }>('/api/tasks', { method: 'POST', body: JSON.stringify({ prompt, locale }) }),
  clarify: (taskId: string, content: string, locale: 'zh' | 'en') => request<{ task: Task; preview: Preview | null; question?: string }>(`/api/tasks/${taskId}/clarifications`, { method: 'POST', body: JSON.stringify({ content, locale }) }),
  approveAccess: (taskId: string, roots: string[], network: boolean) => request<Task>(`/api/tasks/${taskId}/access-scope`, { method: 'POST', body: JSON.stringify({ roots, network }) }),
  run: (taskId: string) => request<Task>(`/api/tasks/${taskId}/run`, { method: 'POST' }),
  feedback: (taskId: string, category: string, comment: string, good: boolean) => request<Task>(`/api/tasks/${taskId}/feedback`, { method: 'POST', body: JSON.stringify({ category, comment, good }) }),
}
