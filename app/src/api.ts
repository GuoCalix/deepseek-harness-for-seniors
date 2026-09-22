import type { Candidate, Preview, Task } from './types'

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, { headers: { 'content-type': 'application/json', ...(options?.headers ?? {}) }, ...options })
  const body = await response.json() as T & { message?: string }
  if (!response.ok) throw new Error(body.message ?? '本地服务暂时不可用')
  return body
}

export const api = {
  listTasks: () => request<Task[]>('/api/tasks'),
  createTask: (prompt: string) => request<{ task: Task; candidates: Candidate[] }>('/api/tasks', { method: 'POST', body: JSON.stringify({ prompt }) }),
  clarify: (taskId: string, content: string) => request<{ task: Task; preview: Preview }>(`/api/tasks/${taskId}/clarifications`, { method: 'POST', body: JSON.stringify({ content }) }),
  approveAccess: (taskId: string, roots: string[], network: boolean) => request<Task>(`/api/tasks/${taskId}/access-scope`, { method: 'POST', body: JSON.stringify({ roots, network }) }),
  run: (taskId: string) => request<Task>(`/api/tasks/${taskId}/run`, { method: 'POST' }),
  feedback: (taskId: string, category: string, comment: string) => request<Task>(`/api/tasks/${taskId}/feedback`, { method: 'POST', body: JSON.stringify({ category, comment }) }),
}
