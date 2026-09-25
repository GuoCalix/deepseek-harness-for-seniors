import { useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Check, ChevronRight, CircleHelp, Clipboard, Clock3, Copy, ExternalLink, FileText, FolderOpen, History, Home, Languages, LoaderCircle, LockKeyhole, Menu, Moon, Pause, Play, Plus, Search, Settings, ShieldCheck, Sparkles, WalletCards, X, Zap } from 'lucide-react'
import { api, openLocalPath } from './api'
import { AccountPanel, LoginContent, useAccount } from './account'
import type { Candidate, Preview, Task, TaskStatus } from './types'
import { copy, type Locale } from './i18n'
import './styles.css'

type View = 'home' | 'history' | 'account' | 'settings'
type Copy = typeof copy.zh | typeof copy.en

const statusTone: Record<TaskStatus, string> = { NEW: 'neutral', CLARIFYING: 'blue', READY_TO_RUN: 'blue', ACCESS_PENDING: 'amber', RUNNING: 'amber', PAUSED: 'amber', REVIEW_REQUIRED: 'red', COMPLETED: 'green', REVISION: 'blue', FAILED: 'red', CANCELLED: 'neutral' }
const statusText: Record<TaskStatus, { zh: string; en: string }> = {
  NEW: { zh: '新任务', en: 'New' }, CLARIFYING: { zh: '需要确认', en: 'Clarifying' }, READY_TO_RUN: { zh: '可以开始', en: 'Ready' }, ACCESS_PENDING: { zh: '等待授权', en: 'Access' }, RUNNING: { zh: '正在处理', en: 'Working' }, PAUSED: { zh: '已暂停', en: 'Paused' }, REVIEW_REQUIRED: { zh: '需要检查', en: 'Review' }, COMPLETED: { zh: '已完成', en: 'Done' }, REVISION: { zh: '准备修改', en: 'Revision' }, FAILED: { zh: '需要重试', en: 'Retry' }, CANCELLED: { zh: '已停止', en: 'Stopped' },
}

function dateLabel(value: string, locale: Locale) {
  return new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value))
}
function bytes(value: number) { return value < 1024 ? `${value} B` : value < 1024 * 1024 ? `${Math.ceil(value / 1024)} KB` : `${(value / 1024 / 1024).toFixed(1)} MB` }
function absolutePath(value: string) { return value.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(value) }

function App() {
  const [locale, setLocale] = useState<Locale>(() => localStorage.getItem('ai-old-locale') === 'en' ? 'en' : 'zh')
  const { status: accountStatus } = useAccount()
  const [view, setView] = useState<View>('home')
  const [tasks, setTasks] = useState<Task[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [candidates, setCandidates] = useState<Candidate[]>([])
  const [preview, setPreview] = useState<Preview | null>(null)
  const [prompt, setPrompt] = useState('')
  const [customClarification, setCustomClarification] = useState('')
  const [selectedCandidate, setSelectedCandidate] = useState<string | null>(null)
  const [feedback, setFeedback] = useState('')
  const [feedbackComment, setFeedbackComment] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [offline, setOffline] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [loginOpen, setLoginOpen] = useState(false)
  const [largeText, setLargeText] = useState(() => localStorage.getItem('ai-old-large') === 'true')
  const [highContrast, setHighContrast] = useState(() => localStorage.getItem('ai-old-contrast') === 'true')
  const t = copy[locale]
  const task = tasks.find(item => item.id === selectedId) ?? null

  useEffect(() => { api.listTasks().then(setTasks).catch(() => setOffline(true)) }, [])
  useEffect(() => { localStorage.setItem('ai-old-locale', locale); document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en' }, [locale])
  useEffect(() => { localStorage.setItem('ai-old-large', String(largeText)); localStorage.setItem('ai-old-contrast', String(highContrast)) }, [largeText, highContrast])
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(''), 3500); return () => clearTimeout(timer) }, [notice])

  async function startTask() {
    if (!prompt.trim() || busy) return
    setBusy(true); setNotice('')
    try {
      const result = await api.createTask(prompt.trim(), locale)
      setTasks(current => [result.task, ...current]); setSelectedId(result.task.id); setCandidates(result.candidates); setPreview(null); setPrompt(''); setView('home')
    } catch (error) { setNotice(error instanceof Error ? error.message : '无法创建任务') } finally { setBusy(false) }
  }
  function openTask(item: Task) {
    const roots = item.previewRoots?.filter(absolutePath) ?? item.accessScope?.roots?.filter(absolutePath) ?? []
    setSelectedId(item.id); setCandidates(item.status === 'CLARIFYING' || item.status === 'REVISION' ? item.candidateOptions ?? candidates : []); setPreview(item.status === 'READY_TO_RUN' ? { target: item.modelSummary ?? item.turns.at(-1)?.content ?? item.title, roots, output: 'workspace/output/任务说明.md', network: '需要联网调用 DeepSeek 生成结果说明' } : null); setView('home'); setFeedback(''); setFeedbackComment('')
  }
  async function submitClarification() {
    if (!task || busy) return
    const selected = selectedCandidate ? candidates.find(item => item.id === selectedCandidate) : undefined
    const content = selected ? `${selected.title}\n说明：${selected.description}\n需要：${selected.needs}` : customClarification.trim()
    if (!content) return
    setBusy(true)
    try { const result = await api.clarify(task.id, content, locale); updateTask(result.task); setCandidates(result.task.status === 'CLARIFYING' ? [] : result.task.candidateOptions ?? []); setPreview(result.preview); setSelectedCandidate(null); setCustomClarification('') }
    catch (error) { setNotice(error instanceof Error ? error.message : '无法保存确认内容') } finally { setBusy(false) }
  }
  async function approveAndRun() {
    if (!task || busy) return
    setBusy(true); updateTask({ ...task, status: 'RUNNING', stage: 'running' })
    try {
      const network = Boolean(preview?.network && !/不需要|无需|不联网|without|no network|offline/iu.test(preview.network))
      const result = await api.run(task.id, preview?.roots ?? [], network); updateTask(result)
    } catch (error) { setNotice(error instanceof Error ? error.message : '任务执行失败') ; updateTask({ ...task, status: 'FAILED', stage: 'failed' }) }
    finally { setBusy(false) }
  }
  async function controlTask(action: 'pause' | 'resume' | 'cancel') {
    if (!task) return
    try { const result = await api[action](task.id); updateTask(result) }
    catch (error) { setNotice(error instanceof Error ? error.message : '无法更新任务状态') }
  }
  async function openResult(path: string) {
    try { await openLocalPath(path) }
    catch (error) { setNotice(error instanceof Error ? error.message : '无法打开任务文件夹') }
  }
  async function sendFeedback() {
    if (!task || !feedback || busy) return
    setBusy(true)
    try { const result = await api.feedback(task.id, feedback, feedbackComment, feedback === t.good); updateTask(result); setFeedback(''); setFeedbackComment('') }
    catch (error) { setNotice(error instanceof Error ? error.message : '反馈提交失败') } finally { setBusy(false) }
  }
  function updateTask(next: Task) { setTasks(current => current.map(item => item.id === next.id ? next : item)) }
  function showView(next: View) { setView(next); setSelectedId(null); setPreview(null) }

  return <div className={`app-shell ${largeText ? 'large-text' : ''} ${highContrast ? 'high-contrast' : ''}`}>
    <Sidebar view={view} onView={showView} t={t} onHelp={() => setHelpOpen(true)} />
    <main className="main-column">
      <header className="topbar">
        <div className="mobile-brand"><Sparkles size={20} /><span>AI for the old</span></div>
        <div className="connection"><span className={`connection-dot ${offline ? 'offline' : ''}`} />{offline ? t.connectionFail : t.connection}</div>
        <div className="top-actions">
          <button className="icon-button" aria-label={t.language} onClick={() => setLocale(locale === 'zh' ? 'en' : 'zh')}><Languages size={18} /><span>{locale === 'zh' ? 'EN' : '中'}</span></button>
          <button className="account-chip" onClick={() => setLoginOpen(true)}><span className="avatar"><LockKeyhole size={18} /></span><span className="account-chip-copy"><strong>{accountStatus?.authMode && accountStatus.authMode !== 'none' ? (accountStatus.profile?.name ?? (locale === 'zh' ? 'DeepSeek 已授权' : 'DeepSeek authorized')) : t.signIn}</strong><small>DeepSeek</small></span><ChevronRight size={16} /></button>
        </div>
      </header>
      <div className="content-wrap">
        {view === 'home' && !selectedId && <HomeView t={t} tasks={tasks} prompt={prompt} setPrompt={setPrompt} onStart={startTask} busy={busy} onOpen={openTask} onSeeAll={() => setView('history')} />}
        {view === 'home' && task && <TaskView t={t} task={task} candidates={candidates} preview={preview} selectedCandidate={selectedCandidate} setSelectedCandidate={setSelectedCandidate} customClarification={customClarification} setCustomClarification={setCustomClarification} onClarify={submitClarification} onRun={approveAndRun} onPause={() => controlTask('pause')} onResume={() => controlTask('resume')} onCancel={() => controlTask('cancel')} onOpenResult={openResult} busy={busy} feedback={feedback} setFeedback={setFeedback} feedbackComment={feedbackComment} setFeedbackComment={setFeedbackComment} onFeedback={sendFeedback} onBack={() => { setSelectedId(null); setPreview(null) }} />}
        {view === 'history' && <HistoryView t={t} tasks={tasks} onOpen={openTask} />}
        {view === 'account' && <AccountPanel locale={locale} onLogin={() => setLoginOpen(true)} />}
        {view === 'settings' && <SettingsView t={t} locale={locale} setLocale={setLocale} largeText={largeText} setLargeText={setLargeText} highContrast={highContrast} setHighContrast={setHighContrast} />}
      </div>
    </main>
    {notice && <div className="toast" role="status"><CircleHelp size={18} />{notice}<button className="toast-close" onClick={() => setNotice('')} aria-label={t.close}><X size={16} /></button></div>}
    {helpOpen && <Modal title={t.helpTitle} onClose={() => setHelpOpen(false)}><p className="modal-copy">{t.helpBody}</p><div className="help-example"><span>“</span><strong>{locale === 'zh' ? '帮我把下载文件夹里的账单合成一个月度表' : 'Make a monthly table from the bills in my Downloads folder'}</strong><span>”</span></div></Modal>}
    {loginOpen && <Modal title={t.login} onClose={() => { void api.cancelAccountLogin(); setLoginOpen(false) }}><LoginContent locale={locale} onDone={() => setLoginOpen(false)} /></Modal>}
  </div>
}

function Sidebar({ view, onView, t, onHelp }: { view: View; onView: (view: View) => void; t: Copy; onHelp: () => void }) {
  const items: { view: View; label: string; icon: typeof Home }[] = [{ view: 'home', label: t.home, icon: Home }, { view: 'history', label: t.history, icon: History }, { view: 'account', label: t.account, icon: WalletCards }, { view: 'settings', label: t.settings, icon: Settings }]
  return <aside className="sidebar"><div className="brand"><span className="brand-mark"><Sparkles size={22} /></span><div><strong>AI for the old</strong><small>DeepSeek workspace</small></div></div><nav className="nav-list" aria-label="Main navigation">{items.map(item => { const Icon = item.icon; return <button className={`nav-item ${view === item.view ? 'active' : ''}`} key={item.view} onClick={() => onView(item.view)}><Icon size={20} /><span>{item.label}</span>{view === item.view && <span className="nav-active-dot" />}</button> })}</nav><div className="sidebar-bottom"><div className="privacy-note"><ShieldCheck size={18} /><div><strong>{t.localFirst}</strong><span>{t.localHint.split('。')[0]}。</span></div></div><button className="help-button" onClick={onHelp}><CircleHelp size={19} /><span>{t.help}</span></button><small className="version-label">v0.1.9 · local-first</small></div></aside>
}

function HomeView({ t, tasks, prompt, setPrompt, onStart, busy, onOpen, onSeeAll }: { t: Copy; tasks: Task[]; prompt: string; setPrompt: (value: string) => void; onStart: () => void; busy: boolean; onOpen: (task: Task) => void; onSeeAll: () => void }) {
  return <div className="home-view"><section className="welcome-copy"><p className="eyebrow"><span className="eyebrow-dot" />{t.localFirst}</p><h1>{t.greeting}</h1><p className="subheading">{t.localHint}</p></section><section className="composer-section"><label className="section-label" htmlFor="prompt">{t.newTask}</label><div className="composer"><textarea id="prompt" rows={4} value={prompt} onChange={event => setPrompt(event.target.value)} placeholder={t.promptHint} onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') onStart() }} /><div className="composer-footer"><span className="composer-tip"><Sparkles size={16} />{t.noThinking}</span><button className="primary-button" disabled={!prompt.trim() || busy} onClick={onStart}>{busy ? <LoaderCircle className="spin" size={19} /> : <Zap size={18} />}{busy ? t.loading : t.start}<ChevronRight size={17} /></button></div></div></section><section className="recent-section"><div className="section-heading"><div><h2>{t.recent}</h2><span>{tasks.length} {t.taskCount}</span></div>{tasks.length > 0 && <button className="text-button" onClick={onSeeAll}>{t.seeAll}<ChevronRight size={16} /></button>}</div>{tasks.length === 0 ? <EmptyState t={t} /> : <div className="task-list">{tasks.slice(0, 4).map(task => <TaskRow key={task.id} task={task} t={t} onClick={() => onOpen(task)} />)}</div>}</section></div>
}

function EmptyState({ t }: { t: Copy }) { return <div className="empty-state"><div className="empty-icon"><FolderOpen size={28} /></div><strong>{t.noTasks}</strong><span>{t.noTasksHint}</span></div> }
function TaskRow({ task, t, onClick }: { task: Task; t: Copy; onClick: () => void }) { return <button className="task-row" onClick={onClick}><span className={`task-type-icon ${statusTone[task.status]}`}><FileText size={20} /></span><span className="task-row-main"><strong>{task.title}</strong><small>{dateLabel(task.updatedAt, 'zh')} · {statusText[task.status][t === copy.zh ? 'zh' : 'en']}</small></span><span className={`status-pill ${statusTone[task.status]}`}>{statusText[task.status][t === copy.zh ? 'zh' : 'en']}</span><ChevronRight className="row-chevron" size={18} /></button> }

function TaskView({ t, task, candidates, preview, selectedCandidate, setSelectedCandidate, customClarification, setCustomClarification, onClarify, onRun, onPause, onResume, onCancel, onOpenResult, busy, feedback, setFeedback, feedbackComment, setFeedbackComment, onFeedback, onBack }: { t: Copy; task: Task; candidates: Candidate[]; preview: Preview | null; selectedCandidate: string | null; setSelectedCandidate: (id: string | null) => void; customClarification: string; setCustomClarification: (value: string) => void; onClarify: () => void; onRun: () => void; onPause: () => void; onResume: () => void; onCancel: () => void; onOpenResult: (path: string) => void; busy: boolean; feedback: string; setFeedback: (value: string) => void; feedbackComment: string; setFeedbackComment: (value: string) => void; onFeedback: () => void; onBack: () => void }) {
  const isClarifying = task.status === 'CLARIFYING' || task.status === 'REVISION'
  return <div className="task-view"><div className="task-header"><button className="back-button" onClick={onBack}><ChevronRight size={18} className="back-icon" />{t.home}</button><div className="task-title-line"><div><p className="eyebrow">{t.version} {task.version}</p><h1>{task.title}</h1></div><span className={`status-pill ${statusTone[task.status]}`}>{statusText[task.status][t === copy.zh ? 'zh' : 'en']}</span></div></div><div className="timeline"><TimelineEvent icon={<Sparkles size={17} />} label={task.prompt} meta={dateLabel(task.createdAt, t === copy.zh ? 'zh' : 'en')} active />{isClarifying && <div className="timeline-card clarification-card"><div className="step-kicker"><span>01</span><span>{t.clarifyTitle}</span></div><p className="card-lead">{task.pendingQuestion ?? t.clarifyHint}</p>{candidates.length > 0 && <div className="candidate-grid">{candidates.map(candidate => <button className={`candidate-card ${selectedCandidate === candidate.id ? 'selected' : ''}`} key={candidate.id} onClick={() => { setSelectedCandidate(candidate.id); setCustomClarification('') }}><span className="candidate-radio">{selectedCandidate === candidate.id && <Check size={15} />}</span><strong>{candidate.title}</strong><span>{candidate.description}</span><small>{candidate.needs}</small></button>)}</div>}{candidates.length > 0 && <button className={`other-option ${!selectedCandidate && customClarification ? 'selected' : ''}`} onClick={() => setSelectedCandidate(null)}><span className="candidate-radio">{!selectedCandidate && customClarification && <Check size={15} />}</span><span>{t.other}</span></button>}{(!selectedCandidate || customClarification) && <textarea className="clarification-input" rows={3} value={customClarification} onChange={event => setCustomClarification(event.target.value)} placeholder={t.promptHint} />}{(selectedCandidate || customClarification.trim()) && <div className="card-actions"><button className="secondary-button" onClick={onBack}>{t.cancel}</button><button className="primary-button" onClick={onClarify} disabled={busy}>{busy ? <LoaderCircle className="spin" size={18} /> : <ChevronRight size={18} />}{t.continue}</button></div>}</div>}{task.status === 'READY_TO_RUN' && preview && <ReadyCard t={t} preview={preview} onRun={onRun} busy={busy} />}{task.status === 'RUNNING' && <ProgressCard t={t} task={task} onPause={onPause} onCancel={onCancel} />}{task.status === 'PAUSED' && <ProgressCard t={t} task={task} onResume={onResume} onCancel={onCancel} />}{task.status === 'COMPLETED' && <ResultCard t={t} task={task} feedback={feedback} setFeedback={setFeedback} feedbackComment={feedbackComment} setFeedbackComment={setFeedbackComment} onFeedback={onFeedback} onOpenResult={onOpenResult} busy={busy} />}{task.status === 'FAILED' && <div className="timeline-card error-card"><CircleHelp size={22} /><div><strong>{t.failed}</strong><p>{task.failureReason ?? t.retry}</p></div><button className="secondary-button" onClick={onRun}>{t.retry}</button></div>}</div></div>
}

function TimelineEvent({ icon, label, meta, active = false }: { icon: React.ReactNode; label: string; meta: string; active?: boolean }) { return <div className={`timeline-event ${active ? 'active' : ''}`}><span className="timeline-dot">{icon}</span><div><strong>{label}</strong><small>{meta}</small></div></div> }
function ReadyCard({ t, preview, onRun, busy }: { t: Copy; preview: Preview; onRun: () => void; busy: boolean }) { return <div className="timeline-card ready-card"><div className="step-kicker"><span>02</span><span>{t.readyTitle}</span></div><div className="review-grid"><ReviewItem icon={<Sparkles size={18} />} title={t.target} value={preview.target} /><ReviewItem icon={<FolderOpen size={18} />} title={t.access} value={preview.roots.join('、')} /><ReviewItem icon={<FileText size={18} />} title={t.output} value={preview.output} /><ReviewItem icon={<LockKeyhole size={18} />} title={t.network} value={preview.network} /></div><div className="consent-row"><ShieldCheck size={19} /><span>{t.localFirst} · {t.noThinkingHint}</span></div><div className="card-actions"><button className="secondary-button" onClick={() => undefined}>{t.cancel}</button><button className="primary-button" onClick={onRun} disabled={busy}>{busy ? <LoaderCircle className="spin" size={18} /> : <Play size={18} />}{t.run}</button></div></div> }
function ReviewItem({ icon, title, value }: { icon: React.ReactNode; title: string; value: string }) { return <div className="review-item"><span>{icon}</span><div><small>{title}</small><strong>{value}</strong></div></div> }
function ProgressCard({ t, task, onPause, onResume, onCancel }: { t: Copy; task: Task; onPause?: () => void; onResume?: () => void; onCancel: () => void }) { const paused = task.status === 'PAUSED'; return <div className="timeline-card progress-card"><div className="progress-heading"><div className="progress-orb">{paused ? <Pause size={28} /> : <LoaderCircle className="spin" size={28} />}</div><div><h2>{paused ? t.paused : t.runningTitle}</h2><p>{t.runningHint}</p></div></div><div className="progress-track"><span style={{ width: `${Math.max(22, task.completedSteps / Math.max(1, task.totalSteps) * 100)}%` }} /></div><div className="progress-stats"><span><strong>{task.foundFiles}</strong>{t.found}</span><span><strong>{task.completedSteps}/{task.totalSteps}</strong>{t.steps}</span><span><strong>{task.elapsedSeconds}s</strong>{t.elapsed}</span></div><div className="progress-actions">{paused ? <button className="secondary-button" onClick={onResume}><Play size={17} />{t.resume}</button> : <button className="secondary-button" onClick={onPause}><Pause size={17} />{t.pause}</button>}<button className="ghost-button" onClick={onCancel}>{t.stop}</button><button className="ghost-button">{t.details}</button></div></div> }
function ResultCard({ t, task, feedback, setFeedback, feedbackComment, setFeedbackComment, onFeedback, onOpenResult, busy }: { t: Copy; task: Task; feedback: string; setFeedback: (value: string) => void; feedbackComment: string; setFeedbackComment: (value: string) => void; onFeedback: () => void; onOpenResult: (path: string) => void; busy: boolean }) {
  const feedbackOptions = task.feedbackOptions ?? []
  return <div className="timeline-card result-card"><div className="result-banner"><span className="success-icon"><Check size={24} /></span><div><h2>{t.completedTitle}</h2><p>{task.resultSummary ?? t.completedHint}</p></div></div><div className="workspace-path"><FolderOpen size={18} /><div><small>{t.folderPath}</small><strong>{task.workspacePath ?? 'workspace/output'}</strong></div><CopyButton value={task.workspacePath ?? ''} t={t} /><button className="icon-button subtle" aria-label={t.openFolder} onClick={() => onOpenResult(task.workspacePath ?? '')}><ExternalLink size={17} /></button></div><div className="artifact-heading"><h3>{t.artifacts}</h3><span>{task.artifacts.length}</span></div><div className="artifact-list">{task.artifacts.map(artifact => <div className="artifact-row" key={artifact.id}><span className="artifact-icon"><FileText size={19} /></span><div><strong>{artifact.name}</strong><small>{bytes(artifact.size)} · {dateLabel(artifact.generatedAt, 'zh')}</small></div><button className="icon-button subtle" aria-label={t.preview} onClick={() => onOpenResult(artifact.path)}><ExternalLink size={17} /></button></div>)}</div><div className="input-summary"><div className="summary-title"><Search size={17} />{t.inputSummary}</div><p>{task.foundFiles} {t.found} · {t.localFirst}</p></div>{task.suggestions?.length ? <div className="suggestion-list"><div className="summary-title"><Sparkles size={17} />{t.suggestions}</div>{task.suggestions.map(suggestion => <p key={suggestion}>{suggestion}</p>)}</div> : null}<div className="feedback-box"><div className="feedback-title"><h3>{t.feedbackTitle}</h3><span>{t.feedbackHint}</span></div><div className="feedback-options"><button className={`feedback-option good ${feedback === t.good ? 'selected' : ''}`} onClick={() => setFeedback(t.good)}><Check size={17} />{t.good}</button>{feedbackOptions.map(item => <button className={`feedback-option ${feedback === item ? 'selected' : ''}`} key={item} onClick={() => setFeedback(item)}>{item}</button>)}</div>{feedback && feedback !== t.good && <textarea className="feedback-input" rows={2} value={feedbackComment} onChange={event => setFeedbackComment(event.target.value)} placeholder={t.commentHint} />}{feedback && <button className="primary-button feedback-submit" onClick={onFeedback} disabled={busy}>{busy ? <LoaderCircle className="spin" size={18} /> : <Check size={18} />}{t.submitFeedback}</button>}</div></div>
}
function CopyButton({ value, t }: { value: string; t: Copy }) { const [state, setState] = useState(false); return <button className="icon-button subtle" onClick={() => { navigator.clipboard?.writeText(value).then(() => setState(true)).catch(() => setState(false)); setTimeout(() => setState(false), 1800) }} aria-label={t.copyPath}>{state ? <Check size={17} /> : <Copy size={17} />}</button> }

function HistoryView({ t, tasks, onOpen }: { t: Copy; tasks: Task[]; onOpen: (task: Task) => void }) { const [filter, setFilter] = useState('all'); const [query, setQuery] = useState(''); const filtered = tasks.filter(task => (filter === 'all' || filter === 'done' && task.status === 'COMPLETED' || filter === 'inProgress' && !['COMPLETED', 'FAILED'].includes(task.status) || filter === 'failed' && task.status === 'FAILED') && task.title.toLowerCase().includes(query.toLowerCase())); return <div className="page-view"><PageTitle icon={<History size={23} />} title={t.history} subtitle={`${tasks.length} ${t.taskCount}`} /><div className="history-toolbar"><div className="search-field"><Search size={18} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder={t.search} /></div><div className="filter-tabs">{[['all', t.all], ['inProgress', t.inProgress], ['done', t.done], ['failed', t.failed]].map(([value, label]) => <button className={filter === value ? 'active' : ''} key={value} onClick={() => setFilter(value)}>{label}</button>)}</div></div>{filtered.length ? <div className="history-list">{filtered.map(task => <TaskRow key={task.id} task={task} t={t} onClick={() => onOpen(task)} />)}</div> : <EmptyState t={t} />}</div> }
function SettingsView({ t, locale, setLocale, largeText, setLargeText, highContrast, setHighContrast }: { t: Copy; locale: Locale; setLocale: (locale: Locale) => void; largeText: boolean; setLargeText: (value: boolean) => void; highContrast: boolean; setHighContrast: (value: boolean) => void }) { return <div className="page-view"><PageTitle icon={<Settings size={23} />} title={t.settings} subtitle={t.localFirst} /><div className="settings-layout"><section className="settings-section"><h2>{t.language}</h2><div className="segmented"><button className={locale === 'zh' ? 'active' : ''} onClick={() => setLocale('zh')}>{t.chinese}</button><button className={locale === 'en' ? 'active' : ''} onClick={() => setLocale('en')}>{t.english}</button></div></section><section className="settings-section"><h2>{t.scale}</h2><SettingToggle label={t.large} detail="18px → 20px" checked={largeText} onChange={setLargeText} /><SettingToggle label={t.contrast} detail="WCAG AA" checked={highContrast} onChange={setHighContrast} /></section><section className="settings-section"><h2>{t.privacy}</h2><div className="setting-info"><span className="setting-icon"><FolderOpen size={19} /></span><div><strong>{t.workspace}</strong><p>~/Desktop/AI for the old/</p></div><button className="icon-button subtle"><ChevronRight size={17} /></button></div><div className="setting-info"><span className="setting-icon green"><ShieldCheck size={19} /></span><div><strong>{t.localFirst}</strong><p>{t.localHint}</p></div></div></section><section className="settings-section"><h2>{t.tools}</h2><p className="section-description">{t.toolsHint}</p><div className="tool-chips">{['list_files', 'read_metadata', 'read_text', 'copy_files', 'move_to_trash', 'create_directory', 'write_text', 'convert_document', 'create_spreadsheet', 'open_result'].map(tool => <span key={tool}><Check size={14} />{tool}</span>)}</div></section></div></div> }
function SettingToggle({ label, detail, checked, onChange }: { label: string; detail: string; checked: boolean; onChange: (value: boolean) => void }) { return <label className="setting-toggle"><span><strong>{label}</strong><small>{detail}</small></span><input type="checkbox" checked={checked} onChange={event => onChange(event.target.checked)} /><span className="toggle-track" /></label> }
function PageTitle({ icon, title, subtitle }: { icon: React.ReactNode; title: string; subtitle: string }) { return <div className="page-title"><span className="page-title-icon">{icon}</span><div><h1>{title}</h1><p>{subtitle}</p></div></div> }
function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) { return <div className="modal-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}><div className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><div className="modal-header"><h2 id="modal-title">{title}</h2><button className="icon-button" onClick={onClose} aria-label="Close"><X size={19} /></button></div>{children}</div></div> }
export default App

const root = document.getElementById('root')
if (!root) throw new Error('Missing #root element')
createRoot(root).render(<App />)
