import {
  Accordion,
  AccordionHeader,
  AccordionItem,
  AccordionPanel,
  AccordionTrigger,
} from '@poietica/design-system'
import {
  ArrowRight,
  Bot,
  CheckCircle2,
  ChevronRight,
  Circle,
  CirclePause,
  CirclePlay,
  CircleX,
  FileDiff,
  GitBranch,
  GitCommitHorizontal,
  Goal,
  Loader2,
  SquareTerminal,
} from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import type { SessionGoal } from '../../agent/goal'
import type {
  BackgroundTaskItem,
  BackgroundTaskStatus,
  TodoItem,
  ToolCallTimelineItem,
} from '../../timeline/timeline-contract'
import { useOptionalThreadGoal } from '../configuration/session-controls-context'
import { GOAL_CONTROL_ID, GOAL_PAUSED, GOAL_RESUMED } from '../goal/goal-control'
import type { WorkspaceGitStatus } from '../goal/workspace-git-status'
import { GitBranchPicker, type GitBranchPickerProps } from '../threads/git-branch-picker'
import {
  useAssistantBackgroundTasks,
  useAssistantTimeline,
  useAssistantTodos,
} from '../transcript/use-assistant-session'
import './todo-panel.css'

/* 区块名与 ZCode ConversationStatusPanel 一致；状态面板的单一分发点在这里。 */
type SectionKind = 'environment' | 'goal' | 'todo' | 'agents' | 'terminals'

/** 各区块内容限高：超出即区块内滚动，与 ZCode 的 max-h-48/max-h-80 同档；environment 不限高。 */
const SECTION_SCROLL_CLASS: Record<SectionKind, string | null> = {
  environment: null,
  goal: 'status-panel__scroll--goal',
  todo: 'status-panel__scroll--todo',
  agents: 'status-panel__scroll--agents',
  terminals: 'status-panel__scroll--terminals',
}

/* 秒针：有任一运行中的行才每秒推一次 now；静止时组件不重渲染。 */
function useNowTicker(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) {
      return undefined
    }
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

/* 同 ZCode formatBackgroundTaskElapsedLabel：分钟档「已运行 M 分 S 秒」，秒档「已运行 S 秒」。 */
export function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(1, Math.floor(elapsedMs / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return minutes > 0 ? `已运行 ${minutes} 分 ${seconds} 秒` : `已运行 ${seconds} 秒`
}

/* 同 ZCode formatDurationUnits：时分秒只取非零段，全零落 0 秒。 */
export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = seconds % 60
  const parts: string[] = []
  if (hours > 0) {
    parts.push(`${hours}小时`)
  }
  if (minutes > 0) {
    parts.push(`${minutes}分`)
  }
  if (rest > 0 || parts.length === 0) {
    parts.push(`${rest}秒`)
  }
  return parts.join(' ')
}

/** 目标用时：agent 报的 wallClockMs 加上快照到达后本地推的时间；暂停即冻结。 */
function goalElapsedSeconds(goal: SessionGoal, now: number): number {
  const extra = goal.status === 'active' ? Math.max(0, now - goal.receivedAt) : 0
  return Math.floor((goal.wallClockMs + extra) / 1000)
}

const TASK_STATUS_LABEL = {
  done: '已完成',
  in_progress: '进行中',
  pending: '待处理',
} as const

const BACKGROUND_STATUS_LABEL: Record<BackgroundTaskStatus, string> = {
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  timed_out: '已超时',
  killed: '已停止',
  lost: '已中断',
}

const BACKGROUND_PROGRESS_LABEL = {
  running: '运行中',
  completed: '已完成',
  interrupted: '已中断',
} as const

/** 零档不提：进度那一格只说非零的桶；桶间分隔用 EN SPACE，不是普通空格。 */
function progressLabel(counts: readonly (readonly [number, string])[]): string {
  return counts
    .filter(([count]) => count > 0)
    .map(([count, label]) => `${count} ${label}`)
    .join('\u2002\u00b7\u2002')
}

export function backgroundTaskProgressLabel(tasks: readonly BackgroundTaskItem[]): string {
  const running = tasks.filter((task) => task.status === 'running').length
  const completed = tasks.filter((task) => task.status === 'completed').length
  /* 零档不提：进度那一格只说非零的桶。空表即空串，调用方据此整格不画。 */
  return progressLabel([
    [running, BACKGROUND_PROGRESS_LABEL.running],
    [completed, BACKGROUND_PROGRESS_LABEL.completed],
    [tasks.length - running - completed, BACKGROUND_PROGRESS_LABEL.interrupted],
  ])
}

/** 这条时间轴上全部 delegate 工具调用，按结清与否分两拨。 */
function delegateCalls(timeline: {
  readonly sealed: readonly { readonly items: readonly unknown[] }[]
  readonly active: { readonly items: readonly unknown[] }
}): { readonly ended: number; readonly running: ToolCallTimelineItem[] } {
  const running: ToolCallTimelineItem[] = []
  let ended = 0
  for (const page of [...timeline.sealed, timeline.active]) {
    for (const item of page.items) {
      const call = item as ToolCallTimelineItem
      if (
        call === null ||
        typeof call !== 'object' ||
        call.type !== 'tool_call' ||
        call.kind !== 'delegate'
      ) {
        continue
      }
      if (call.status === 'in_progress' || call.status === 'pending') {
        running.push(call)
      } else {
        ended += 1
      }
    }
  }
  return { ended, running }
}

/* 分区头与 ZCode StatusSection 同构：标题 + 折叠钮 + 行内摘要。 */
function Section({
  children,
  footer,
  separated = false,
  summary,
  title,
  value,
}: {
  readonly children: ReactNode
  /* 常显页脚（ZCode 的 EndedDirectoryRow）：终态入口不随折叠藏起来。 */
  readonly footer?: ReactNode
  readonly separated?: boolean
  readonly summary?: (open: boolean) => ReactNode
  readonly title: string
  readonly value: SectionKind
}) {
  const scrollClass = SECTION_SCROLL_CLASS[value]
  return (
    <AccordionItem
      className="status-panel__section"
      data-separated={separated || undefined}
      value={value}
    >
      <AccordionHeader className="status-panel__heading">
        <AccordionTrigger className="status-panel__trigger">
          <span className="status-panel__title">{title}</span>
          <ChevronRight aria-hidden className="status-panel__chevron" />
          <span className="status-panel__trailing">{summary?.(false)}</span>
        </AccordionTrigger>
      </AccordionHeader>
      <AccordionPanel className="status-panel__body">
        <div
          className={
            scrollClass === null ? 'status-panel__region' : `status-panel__region ${scrollClass}`
          }
        >
          {children}
        </div>
      </AccordionPanel>
      {footer}
    </AccordionItem>
  )
}

/* ── Git 工具（环境） ─────────────────────────────────────────────────── */

/*
 * 复刻 ZCode GitStatusSection：「更改 +N -M」→ 分支切换器 → 「提交或推送」。
 * 闸门同 ZCode 的 buildGitModel：没有改动就不开这一区，否则每条会话顶着一张空卡。
 */
function GitStatusSection({
  git,
  onOpenReview,
  picker,
}: {
  readonly git: WorkspaceGitStatus
  /* 「提交或推送」那一行交给审查面：那里有完整的提交/推送与信息输入，不在这里再造一份。 */
  readonly onOpenReview?: (() => void) | undefined
  readonly picker?: GitBranchPickerProps | undefined
}) {
  const added = git.added ?? 0
  const removed = git.removed ?? 0
  if (added + removed <= 0) {
    return null
  }
  return (
    <Section
      /*
       * 收起态把 +N -M 留在标题右边（ZCode GitStatusSection 的 trailing 就是这个）；
       * 展开时正文里已经有一行「更改」在报同样的数，那一份由 CSS 撤掉，不重复造。
       */
      summary={() => (
        <span className="status-panel__git-stats status-panel__git-stats--summary">
          <span className="status-panel__added">+{added}</span>{' '}
          <span className="status-panel__removed">-{removed}</span>
        </span>
      )}
      title="Git 工具"
      value="environment"
    >
      <div className="status-panel__git">
        <div className="status-panel__git-row" data-git-row="changes">
          <FileDiff aria-hidden className="status-panel__item-icon" />
          <span className="status-panel__git-label">更改</span>
          <span className="status-panel__git-stats">
            <span className="status-panel__added">+{added}</span>{' '}
            <span className="status-panel__removed">-{removed}</span>
          </span>
        </div>
        {/* 分支那一行就是切换入口本身（ZCode 的 GitBranchSwitcher 也铺满这行）。 */}
        <div className="status-panel__git-row status-panel__git-row--branch" data-git-row="branch">
          {picker === undefined ? (
            <>
              <GitBranch aria-hidden className="status-panel__item-icon" />
              <span className="status-panel__git-label">{git.branch ?? '分离 HEAD'}</span>
            </>
          ) : (
            <GitBranchPicker {...picker} />
          )}
        </div>
        <button
          className="status-panel__git-row status-panel__git-row--action"
          data-git-row="commit"
          disabled={onOpenReview === undefined}
          onClick={() => onOpenReview?.()}
          type="button"
        >
          <GitCommitHorizontal aria-hidden className="status-panel__item-icon" />
          <span className="status-panel__git-label">提交或推送</span>
        </button>
      </div>
    </Section>
  )
}

/* ── 目标 ─────────────────────────────────────────────────────────────── */

function GoalSection({
  goal,
  onPause,
  onResume,
  separated,
}: {
  readonly goal: SessionGoal
  readonly onPause: () => void
  readonly onResume: () => void
  readonly separated: boolean
}) {
  const ticking = goal.status === 'active'
  const now = useNowTicker(ticking)
  const elapsed = formatDuration(goalElapsedSeconds(goal, now))

  return (
    <Section
      separated={separated}
      summary={() => (
        <>
          <span
            className="status-panel__elapsed"
            data-goal-elapsed-seconds={goalElapsedSeconds(goal, now)}
          >
            {elapsed}
          </span>
          {goal.status === 'active' || goal.status === 'paused' ? (
            <>
              <span aria-hidden className="status-panel__dot">
                ·
              </span>
              <button
                aria-label={goal.status === 'active' ? '暂停目标' : '继续目标'}
                className="status-panel__icon-button"
                data-goal-action={goal.status === 'active' ? 'pause' : 'resume'}
                onClick={(event) => {
                  event.stopPropagation()
                  if (goal.status === 'active') {
                    onPause()
                  } else {
                    onResume()
                  }
                }}
                type="button"
              >
                {goal.status === 'active' ? (
                  <CirclePause aria-hidden className="status-panel__icon" />
                ) : (
                  <CirclePlay aria-hidden className="status-panel__icon" />
                )}
              </button>
            </>
          ) : null}
        </>
      )}
      title="目标"
      value="goal"
    >
      <div className="status-panel__goal" data-goal-status={goal.status}>
        <Goal aria-hidden className="status-panel__item-icon" />
        <p className="status-panel__goal-text" title={goal.objective}>
          {goal.objective}
        </p>
        {goal.turnsUsed > 0 ? <span className="status-panel__count">{goal.turnsUsed}</span> : null}
      </div>
    </Section>
  )
}

/* ── 进程（待办） ─────────────────────────────────────────────────────── */

/* 与 ZCode 同一道精简窗口：超过 6 项只画焦点三条，前/后各折一条占位行。 */
const COMPACT_TODO_THRESHOLD = 6
const TODO_FOCUS_WINDOW_SIZE = 3

interface TodoFocusWindow {
  readonly compact: boolean
  readonly preceding: readonly TodoItem[]
  readonly focus: readonly TodoItem[]
  readonly following: readonly TodoItem[]
}

export function todoFocusWindow(items: readonly TodoItem[]): TodoFocusWindow {
  if (items.length <= COMPACT_TODO_THRESHOLD) {
    return { compact: false, preceding: [], focus: items, following: [] }
  }
  const runningIndex = items.findIndex((item) => item.status === 'in_progress')
  const firstUnfinishedIndex = items.findIndex((item) => item.status !== 'done')
  const focusIndex =
    runningIndex >= 0
      ? runningIndex
      : firstUnfinishedIndex >= 0
        ? firstUnfinishedIndex
        : Math.max(0, items.length - TODO_FOCUS_WINDOW_SIZE)
  const start = Math.max(0, Math.min(focusIndex, items.length - TODO_FOCUS_WINDOW_SIZE))
  const end = Math.min(items.length, start + TODO_FOCUS_WINDOW_SIZE)
  return {
    compact: true,
    preceding: items.slice(0, start),
    focus: items.slice(start, end),
    following: items.slice(end),
  }
}

function TodoStatusGlyph({ status }: { readonly status: TodoItem['status'] }) {
  if (status === 'done') {
    return <CheckCircle2 aria-hidden className="status-panel__glyph--done" />
  }
  if (status === 'in_progress') {
    return <ArrowRight aria-hidden className="status-panel__glyph--active" />
  }
  return <Circle aria-hidden className="status-panel__glyph--pending" />
}

function TodoSection({
  separated,
  todos,
}: {
  readonly separated: boolean
  readonly todos: readonly TodoItem[]
}) {
  /* 没有待办事项就整格不提：空表画一行「暂无任务」是废话，摘要也不留 0/0。 */
  if (todos.length === 0) {
    return null
  }
  const done = todos.filter((item) => item.status === 'done').length
  const window = todoFocusWindow(todos)
  const renderItem = (item: TodoItem, index: number) => (
    <li
      className="status-panel__item"
      data-status={item.status}
      key={[`todo-${index}`, item.title].join(':')}
    >
      <span aria-label={TASK_STATUS_LABEL[item.status]} className="status-panel__glyph" role="img">
        <TodoStatusGlyph status={item.status} />
      </span>
      <span
        className="status-panel__item-text"
        data-done={item.status === 'done' || undefined}
        title={item.title}
      >
        {item.title}
      </span>
    </li>
  )
  return (
    <Section
      separated={separated}
      summary={() => (
        <span
          className={
            done === todos.length
              ? 'status-panel__count status-panel__count--success'
              : 'status-panel__count'
          }
        >
          {done}/{todos.length}
        </span>
      )}
      title="待办事项"
      value="todo"
    >
      <ul className="status-panel__list">
        {window.compact && window.preceding.length > 0 ? (
          <li className="status-panel__fold">
            <ChevronRight aria-hidden className="status-panel__fold-icon" />
            <span>
              {window.preceding.every((item) => item.status === 'done')
                ? `已完成 ${window.preceding.length} 项`
                : `前面 ${window.preceding.length} 项`}
            </span>
          </li>
        ) : null}
        {window.focus.map(renderItem)}
        {window.compact && window.following.length > 0 ? (
          <li className="status-panel__fold">
            <ChevronRight aria-hidden className="status-panel__fold-icon" />
            <span>
              {window.following.every((item) => item.status === 'pending')
                ? `待处理 ${window.following.length} 项`
                : `后面 ${window.following.length} 项`}
            </span>
          </li>
        ) : null}
      </ul>
    </Section>
  )
}

/* ── 智能体（子代理） ─────────────────────────────────────────────────── */

function AgentsSection({
  agents,
  endedCount,
  separated,
}: {
  readonly agents: readonly ToolCallTimelineItem[]
  readonly endedCount: number
  readonly separated: boolean
}) {
  /*
   * hook 先于闸门：ticking/排序都是无条件调用，闸门放在它们之后 ——
   * 早退写在 hook 之前会让同一组件的 hook 顺序随数据变化，是 React 的硬错。
   */
  const ticking = agents.length > 0
  const now = useNowTicker(ticking)
  /* 与 ZCode 同：子代理按启动先后排，投影本身无序。 */
  const ordered = useMemo(
    () => [...agents].sort((left, right) => left.startedAt - right.startedAt),
    [agents],
  )
  if (agents.length === 0 && endedCount <= 0) {
    return null
  }
  const longest = ordered.reduce((carry, agent) => Math.max(carry, now - agent.startedAt), 0)
  return (
    <Section
      footer={
        /* ZCode EndedDirectoryRow：终态子代理不占活动列表的位置，但入口必须留着。 */
        endedCount > 0 ? (
          <div className="status-panel__ended" data-separated={agents.length > 0 || undefined}>
            <span className="status-panel__ended-row">
              <CheckCircle2 aria-hidden className="status-panel__item-icon" />
              <span className="status-panel__git-label">已结束</span>
              <span className="status-panel__count">{endedCount}</span>
              <ChevronRight aria-hidden className="status-panel__ended-chevron" />
            </span>
          </div>
        ) : null
      }
      separated={separated}
      summary={() => (
        <>
          <span className="status-panel__elapsed">{formatDuration(longest / 1000)}</span>
          <span aria-hidden className="status-panel__dot">
            ·
          </span>
          <span className="status-panel__count">{agents.length} 运行</span>
        </>
      )}
      title="智能体"
      value="agents"
    >
      <ul className="status-panel__list">
        {ordered.map((agent) => (
          <li
            className="status-panel__item status-panel__item--column"
            data-kind="agent"
            key={agent.toolCallId}
          >
            <Bot aria-hidden className="status-panel__item-icon" />
            <div className="status-panel__item-body">
              <span className="status-panel__item-text" title={agent.title}>
                {agent.title}
              </span>
              <span className="status-panel__elapsed">{formatElapsed(now - agent.startedAt)}</span>
            </div>
          </li>
        ))}
      </ul>
    </Section>
  )
}

/* ── 终端（后台任务） ─────────────────────────────────────────────────── */

function BackgroundStatusGlyph({ status }: { readonly status: BackgroundTaskStatus }) {
  if (status === 'running') {
    return <Loader2 aria-hidden className="status-panel__glyph--active status-panel__spin" />
  }
  if (status === 'completed') {
    return <CheckCircle2 aria-hidden className="status-panel__glyph--done" />
  }
  return <CircleX aria-hidden className="status-panel__glyph--failed" />
}

function TerminalsSection({
  separated,
  tasks,
}: {
  readonly separated: boolean
  readonly tasks: readonly BackgroundTaskItem[]
}) {
  /* hook 先于闸门：早退写在 hook 之前会让同一组件的 hook 顺序随数据变化，是 React 的硬错。 */
  const running = tasks.filter((task) => task.status === 'running' && task.startedAt !== undefined)
  const now = useNowTicker(running.length > 0)
  /* 没有后台任务就整格不提，同待办事项：空表画一行「暂无」是废话。 */
  if (tasks.length === 0) {
    return null
  }
  return (
    <Section
      separated={separated}
      summary={() => (
        <span className="status-panel__count">{backgroundTaskProgressLabel(tasks)}</span>
      )}
      title="后台任务"
      value="terminals"
    >
      <ul className="status-panel__list">
        {tasks.map((task) => (
          <li className="status-panel__item" data-status={task.status} key={task.taskId}>
            <span
              aria-label={BACKGROUND_STATUS_LABEL[task.status]}
              className="status-panel__glyph"
              role="img"
            >
              <BackgroundStatusGlyph status={task.status} />
            </span>
            <SquareTerminal aria-hidden className="status-panel__item-icon" />
            <div className="status-panel__item-body">
              <span className="status-panel__item-text" title={task.description}>
                {task.description}
              </span>
              {task.status === 'running' && task.startedAt !== undefined ? (
                <span className="status-panel__elapsed">{formatElapsed(now - task.startedAt)}</span>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </Section>
  )
}

/* ── 面板 ─────────────────────────────────────────────────────────────── */

export function TaskPanelContent({
  backgroundTasks,
  endedAgents = 0,
  git,
  gitPicker,
  goal,
  onOpenReview,
  onPauseGoal,
  onResumeGoal,
  runningAgents,
  todos,
}: {
  readonly backgroundTasks: readonly BackgroundTaskItem[]
  readonly git?: WorkspaceGitStatus | undefined
  readonly gitPicker?: GitBranchPickerProps | undefined
  readonly goal?: SessionGoal | undefined
  readonly onOpenReview?: (() => void) | undefined
  readonly onPauseGoal?: (() => void) | undefined
  readonly onResumeGoal?: (() => void) | undefined
  readonly endedAgents?: number | undefined
  readonly runningAgents?: readonly ToolCallTimelineItem[]
  readonly todos: readonly TodoItem[]
}) {
  const agents = runningAgents ?? []
  const showGoal = goal !== undefined && goal.status !== 'complete'
  const showAgents = agents.length > 0 || endedAgents > 0
  const showGit = git !== undefined && (git.added ?? 0) + (git.removed ?? 0) > 0

  /*
   * 每一格都是有事实才出现：空表连标题都不画（原来「待办事项 / 后台任务」常驻并各说
   * 一句「暂无」，那是两块永远空着的标题加两句废话）。
   *
   * 展开与否按同一条规则：**有内容的才默认展开，空的谈不上**。全展开会把一块面板
   * 铺成一屏空白；全收起则等于把「有待办在跑」这件事藏起来，都得点一下才知道。
   * Git 是唯一例外 —— 它出现即意味着有改动，恒展开。
   */
  const expanded = [
    ...(showGit ? ['environment'] : []),
    ...(showGoal ? ['goal'] : []),
    ...(todos.length > 0 ? ['todo'] : []),
    ...(showAgents ? ['agents'] : []),
    ...(backgroundTasks.length > 0 ? ['terminals'] : []),
  ]

  return (
    <Accordion
      aria-label="任务与后台任务"
      className="status-panel"
      defaultValue={expanded}
      multiple
    >
      {showGit && git !== undefined ? (
        <GitStatusSection git={git} onOpenReview={onOpenReview} picker={gitPicker} />
      ) : null}
      {showGoal && goal !== undefined ? (
        <GoalSection
          goal={goal}
          onPause={() => onPauseGoal?.()}
          onResume={() => onResumeGoal?.()}
          separated={false}
        />
      ) : null}
      <TodoSection separated={showGit || showGoal} todos={todos} />
      {showAgents ? <AgentsSection agents={agents} endedCount={endedAgents} separated /> : null}
      <TerminalsSection separated tasks={backgroundTasks} />
    </Accordion>
  )
}

export function TodoPanel({
  git,
  gitPicker,
  onOpenReview,
  threadId,
}: {
  readonly git?: WorkspaceGitStatus | undefined
  readonly gitPicker?: GitBranchPickerProps | undefined
  readonly onOpenReview?: (() => void) | undefined
  readonly threadId: string
}) {
  const todos = useAssistantTodos(threadId)
  const backgroundTasks = useAssistantBackgroundTasks(threadId)
  const timeline = useAssistantTimeline(threadId)
  const { controls, goal } = useOptionalThreadGoal(threadId)
  const delegates = useMemo(() => delegateCalls(timeline), [timeline])

  return (
    <TaskPanelContent
      backgroundTasks={backgroundTasks}
      endedAgents={delegates.ended}
      git={git}
      gitPicker={gitPicker}
      goal={goal}
      onOpenReview={onOpenReview}
      onPauseGoal={() => {
        void controls?.selectControl(threadId, GOAL_CONTROL_ID, GOAL_PAUSED)
      }}
      onResumeGoal={() => {
        void controls?.selectControl(threadId, GOAL_CONTROL_ID, GOAL_RESUMED)
      }}
      runningAgents={delegates.running}
      todos={todos}
    />
  )
}
