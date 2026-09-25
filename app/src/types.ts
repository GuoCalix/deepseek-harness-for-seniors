export type TaskStatus = 'NEW' | 'CLARIFYING' | 'READY_TO_RUN' | 'ACCESS_PENDING' | 'RUNNING' | 'PAUSED' | 'REVIEW_REQUIRED' | 'COMPLETED' | 'REVISION' | 'FAILED' | 'CANCELLED'

export interface Candidate { id: string; title: string; description: string; needs: string }
export interface Artifact { id: string; name: string; path: string; kind: string; size: number; generatedAt: string; version: number }
export interface TaskEvent { id: string; type: string; label: string; occurredAt: string; foundFiles?: number }
export interface Task {
  id: string; title: string; prompt: string; locale?: 'zh' | 'en'; status: TaskStatus; stage: string; createdAt: string; updatedAt: string
  workspacePath: string | null; turns: { id: string; role: string; content: string; createdAt: string }[]
  events: TaskEvent[]; artifacts: Artifact[]; feedback: { id: string; category: string; comment: string; createdAt: string }[]
  accessScope: { roots: string[]; network: boolean; agreedAt: string } | null; version: number
  foundFiles: number; completedSteps: number; totalSteps: number; elapsedSeconds: number
  candidateOptions?: Candidate[]; pendingQuestion?: string; modelSummary?: string
  previewRoots?: string[]
  resultSummary?: string; suggestions?: string[]; feedbackOptions?: string[]; failureReason?: string
}

export interface Preview { target: string; roots: string[]; output: string; network: string; summary?: string }
