import {
  Accordion,
  AccordionHeader,
  AccordionItem,
  AccordionPanel,
  AccordionTrigger,
  GitBranchPicker,
  type GitBranchPickerProps,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
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
  Square,
  SquareTerminal,
} from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { useWorkspaceGitFacts, type WorkspaceGitStatus } from '../../../ui-api'
import { useOptionalThreadGoal } from '../../session'
import type { SessionGoal } from '../../shared/model/goal'
import { GOAL_CONTROL_ID, GOAL_PAUSED, GOAL_RESUMED } from '../../shared/model/goal-control'
import { useSecond } from '../../shared/primitives/clock'
import type {
  BackgroundTaskItem,
  BackgroundTaskStatus,
  SubagentItem,
  TodoItem,
  ToolCallTimelineItem,
} from '../../shared/timeline/timeline-contract'
import {
  delegateCallsOf,
  type OpenDelegateChannel,
  useAgentControls,
  useAssistantBackgroundTasks,
  useAssistantSubagents,
  useAssistantTimeline,
  useAssistantTodos,
  useOptionalDelegateChannel,
} from '../../timeline'
import './todo-panel.css'

type SectionKind = 'environment' | 'goal' | 'todo' | 'agents' | 'terminals'

const SECTION_SCROLL_CLASS: Record<SectionKind, string | null> = {
  environment: null,
  goal: 'status-panel__scroll--goal',
  todo: 'status-panel__scroll--todo',
  agents: 'status-panel__scroll--agents',
  terminals: 'status-panel__scroll--terminals',
}

export function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(1, Math.floor(elapsedMs / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return minutes > 0 ? `已运行 ${minutes} 分 ${seconds} 秒` : `已运行 ${seconds} 秒`
}

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

/** 目标用时 = agent 报的 wallClockMs + 快照到达后本地推的时间；暂停即冻结。 */
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

/** 零档不提：只说非零的桶；桶间分隔用 EN SPACE，不是普通空格。 */
function progressLabel(counts: readonly (readonly [number, string])[]): string {
  return counts
    .filter(([count]) => count > 0)
    .map(([count, label]) => `${count} ${label}`)
    .join('\u2002\u00b7\u2002')
}

function backgroundTaskProgressLabel(tasks: readonly BackgroundTaskItem[]): string {
  const running = tasks.filter((task) => task.status === 'running').length
  const completed = tasks.filter((task) => task.status === 'completed').length
  /* 空表即空串，调用方据此整格不画。 */
  return progressLabel([
    [running, BACKGROUND_PROGRESS_LABEL.running],
    [completed, BACKGROUND_PROGRESS_LABEL.completed],
    [tasks.length - running - completed, BACKGROUND_PROGRESS_LABEL.interrupted],
  ])
}

/* 两个来源折成同一个形状：agent 自己报的生命周期帧（detached 子代理的唯一真相），以及时间线上的 delegate 调用（重开旧对话时总线上没有任何帧）。 */
export interface AgentRow {
  readonly key: string
  readonly title: string
  readonly startedAt: number
  /** 通道地址：有它这一行才点得开（右坞「子代理」标签）。只有一次没报出子代理的派发调用才缺席。 */
  readonly agentId?: string
  /** 终态行才有：已完成 / 失败 / 已停止 … 画在行尾。 */
  readonly status?: BackgroundTaskStatus
}

const AGENT_STATUS_LABEL = BACKGROUND_STATUS_LABEL

/* 一次 task 调用可以派出好几个子代理（channels 一条一个）：按通道拆行，每行各自点得开；还没报出通道的调用整条算一行。 */
function delegateRows(call: ToolCallTimelineItem, status?: BackgroundTaskStatus): AgentRow[] {
  const extra = status === undefined ? {} : { status }
  if (call.channels.length === 0) {
    return [{ key: call.toolCallId, title: call.title, startedAt: call.startedAt, ...extra }]
  }
  return call.channels.map((channel) => ({
    key: `${call.toolCallId}:${channel.agentId}`,
    title: channel.name === '' ? call.title : channel.name,
    startedAt: call.startedAt,
    agentId: channel.agentId,
    ...extra,
  }))
}

/* 有总线帧就用总线帧，否则退回 delegate 工具调用：两条都画会在屏幕上把同一个子代理列两遍。 */
export function agentRows(
  subagents: readonly SubagentItem[],
  delegates: {
    readonly finished: readonly ToolCallTimelineItem[]
    readonly running: readonly ToolCallTimelineItem[]
  },
): { readonly ended: readonly AgentRow[]; readonly running: readonly AgentRow[] } {
  if (subagents.length === 0) {
    return {
      ended: delegates.finished.flatMap((call) =>
        delegateRows(call, call.status === 'failed' ? 'failed' : 'completed'),
      ),
      running: delegates.running.flatMap((call) => delegateRows(call)),
    }
  }

  const running: AgentRow[] = []
  const ended: AgentRow[] = []

  for (const agent of subagents) {
    const row = {
      key: agent.agentId,
      title: agent.description,
      agentId: agent.agentId,
      /* 启动时刻缺席时用 0：排序稳定；秒针会显示成很大的数，比丢行好。 */
      startedAt: agent.startedAt ?? 0,
    }
    if (agent.status === 'running') {
      running.push(row)
    } else {
      ended.push({ ...row, status: agent.status })
    }
  }

  return { ended, running }
}

function Section({
  children,
  footer,
  separated = false,
  summary,
  title,
  value,
}: {
  readonly children: ReactNode
  /* 常显页脚：终态入口不随折叠藏起来，所以放在折叠面板之外。 */
  readonly footer?: ReactNode
  readonly separated?: boolean
  readonly summary?: (open: boolean) => ReactNode
  readonly title: string
  readonly value: SectionKind
}) {
  const scrollClass = SECTION_SCROLL_CLASS[value]
  return (
    <AccordionItem className="status-panel__section" data-separated={separated || undefined} value={value}>
      <AccordionHeader className="status-panel__heading">
        <AccordionTrigger className="status-panel__trigger">
          <span className="status-panel__title">{title}</span>
          <ChevronRight aria-hidden className="status-panel__chevron" />
          <span className="status-panel__trailing">{summary?.(false)}</span>
        </AccordionTrigger>
      </AccordionHeader>
      <AccordionPanel className="status-panel__body">
        <div className={scrollClass === null ? 'status-panel__region' : `status-panel__region ${scrollClass}`}>
          {children}
        </div>
      </AccordionPanel>
      {footer}
    </AccordionItem>
  )
}

/* 只要是 git 工作区就恒画，干净仓库照画（+0 -0）：undefined 才是「这一区不画」（不是仓库、没装 git、还没读到）。 */
/* 导出只为测试：钉住「干净仓库也画得出 +0 -0」这一格长什么样。 */
function GitStatusSection({
  git,
  onOpenReview,
  picker,
}: {
  readonly git: WorkspaceGitStatus
  /* 「提交或推送」交给审查面：那里有完整的提交/推送与信息输入，不在这里再造一份。 */
  readonly onOpenReview?: (() => void) | undefined
  readonly picker?: GitBranchPickerProps | undefined
}) {
  /* 两个数照实报，没有「不报数」这一档：0 就是干净的 0（缺席会把「不知道」说成「没改动」，也让「干净仓库」与「没读到」长得一样）。 */
  const stats = (
    <>
      <span className="status-panel__added">+{git.added}</span>{' '}
      <span className="status-panel__removed">-{git.removed}</span>
    </>
  )
  return (
    <Section
      /* 收起态把 +N -M 留在标题右边；展开时正文已有一行「更改」在报同样的数。 */
      summary={() => <span className="status-panel__git-stats status-panel__git-stats--summary">{stats}</span>}
      title="Git 工具"
      value="environment"
    >
      <div className="status-panel__git">
        <div className="status-panel__git-row" data-git-row="changes">
          <FileDiff aria-hidden className="status-panel__item-icon" />
          <span className="status-panel__git-label">更改</span>
          <span className="status-panel__git-stats">{stats}</span>
        </div>
        {/* 分支那一行就是切换入口本身。 */}
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
  const now = useSecond(ticking)
  const elapsed = formatDuration(goalElapsedSeconds(goal, now))

  return (
    <Section
      separated={separated}
      summary={() => (
        <>
          <span className="status-panel__elapsed" data-goal-elapsed-seconds={goalElapsedSeconds(goal, now)}>
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

const COMPACT_TODO_THRESHOLD = 6
const TODO_FOCUS_WINDOW_SIZE = 3

interface TodoFocusWindow {
  readonly compact: boolean
  readonly preceding: readonly TodoItem[]
  readonly focus: readonly TodoItem[]
  readonly following: readonly TodoItem[]
}

function todoFocusWindow(items: readonly TodoItem[]): TodoFocusWindow {
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

/* 悬浮卡最多列这么多行：再多就超出视口了，剩下的用一行「还有 N 项」带过。 */
const TODO_FOLD_PREVIEW_LIMIT = 12

/* 待办的一行：列表本身与折叠悬浮卡共用这一份，两处的字号、行高、图标与删除线因此永远一致。 */
function TodoRow({ item }: { readonly item: TodoItem }) {
  return (
    <li className="status-panel__item" data-status={item.status}>
      <span aria-label={TASK_STATUS_LABEL[item.status]} className="status-panel__glyph" role="img">
        <TodoStatusGlyph status={item.status} />
      </span>
      <span className="status-panel__item-text" data-done={item.status === 'done' || undefined} title={item.title}>
        {item.title}
      </span>
    </li>
  )
}

/*
 * 折起来的那几项（「已完成 N 项」「待处理 N 项」）：悬停或键盘聚焦时，在面板左侧弹出一张卡逐条列出。
 * 卡片就是一块小号的状态面板：挂 .status-panel 拿到同一套墨色与深浅主题，行用 TodoRow，外壳照面板的边、圆角、底色 ——
 * 不用默认的提示气泡皮（12px 反色小字），那是解释按钮用的，与面板里的列表不是一种东西。
 * 触发器是行内的按钮而不是 li 本身：键盘用户也要能聚焦到它，Base UI 的触发器也需要一个可以聚焦的元素。
 */
function TodoFold({ items, label }: { readonly items: readonly TodoItem[]; readonly label: string }) {
  const shown = items.slice(0, TODO_FOLD_PREVIEW_LIMIT)
  const rest = items.length - shown.length
  return (
    <li className="status-panel__fold-item">
      <TooltipProvider delay={150}>
        <Tooltip>
          <TooltipTrigger className="status-panel__fold" type="button">
            <ChevronRight aria-hidden className="status-panel__fold-icon" />
            <span>{label}</span>
          </TooltipTrigger>
          {/* 偏移 = 面板内边距 8 + 外框 1 + 留缝 8：卡片贴在面板外侧，而不是压在面板上。 */}
          <TooltipContent className="status-panel status-panel__fold-card" side="left" sideOffset={17}>
            <ul className="status-panel__list">
              {shown.map((item, index) => (
                <TodoRow item={item} key={[`fold-${index}`, item.title].join(':')} />
              ))}
              {rest > 0 ? (
                <li className="status-panel__fold status-panel__fold-more">
                  <span>还有 {rest} 项</span>
                </li>
              ) : null}
            </ul>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </li>
  )
}

function TodoSection({ separated, todos }: { readonly separated: boolean; readonly todos: readonly TodoItem[] }) {
  /* 空表整格不提：画一行「暂无任务」是废话，摘要也不留 0/0。 */
  if (todos.length === 0) {
    return null
  }
  const done = todos.filter((item) => item.status === 'done').length
  const window = todoFocusWindow(todos)
  const renderItem = (item: TodoItem, index: number) => (
    <TodoRow item={item} key={[`todo-${index}`, item.title].join(':')} />
  )
  return (
    <Section
      separated={separated}
      summary={() => (
        <span
          className={done === todos.length ? 'status-panel__count status-panel__count--success' : 'status-panel__count'}
        >
          {done}/{todos.length}
        </span>
      )}
      title="待办事项"
      value="todo"
    >
      <ul className="status-panel__list">
        {window.compact && window.preceding.length > 0 ? (
          <TodoFold
            items={window.preceding}
            label={
              window.preceding.every((item) => item.status === 'done')
                ? `已完成 ${window.preceding.length} 项`
                : `前面 ${window.preceding.length} 项`
            }
          />
        ) : null}
        {window.focus.map(renderItem)}
        {window.compact && window.following.length > 0 ? (
          <TodoFold
            items={window.following}
            label={
              window.following.every((item) => item.status === 'pending')
                ? `待处理 ${window.following.length} 项`
                : `后面 ${window.following.length} 项`
            }
          />
        ) : null}
      </ul>
    </Section>
  )
}

/* 一行子代理：有通道地址又有出口时整行是按钮（打开右坞里它的标签），否则只是一行字。 */
function AgentRowView({
  agent,
  now,
  onOpen,
}: {
  readonly agent: AgentRow
  readonly now: number
  readonly onOpen?: OpenDelegateChannel | undefined
}) {
  const body = (
    <>
      <Bot aria-hidden className="status-panel__item-icon" />
      <div className="status-panel__item-body">
        <span className="status-panel__item-text" title={agent.title}>
          {agent.title}
        </span>
        {agent.status === undefined ? (
          <span className="status-panel__elapsed">{formatElapsed(now - agent.startedAt)}</span>
        ) : null}
      </div>
      {agent.status === undefined ? null : (
        <span className="status-panel__count" data-agent-status={agent.status}>
          {AGENT_STATUS_LABEL[agent.status]}
        </span>
      )}
    </>
  )
  const agentId = agent.agentId
  return (
    <li className="status-panel__agent" data-kind="agent" data-status={agent.status ?? 'running'}>
      {agentId === undefined || onOpen === undefined ? (
        <div className="status-panel__item status-panel__item--column">{body}</div>
      ) : (
        <button
          className="status-panel__item status-panel__item--column status-panel__item--action"
          data-agent-id={agentId}
          onClick={() => onOpen(agentId, agent.title)}
          title="在右侧打开这个子代理的对话"
          type="button"
        >
          {body}
        </button>
      )}
    </li>
  )
}

function AgentsSection({
  agents,
  ended,
  onOpenAgent,
  separated,
}: {
  readonly agents: readonly AgentRow[]
  readonly ended: readonly AgentRow[]
  readonly onOpenAgent?: OpenDelegateChannel | undefined
  readonly separated: boolean
}) {
  /* hook 先于闸门：早退写在 hook 之前会让同一组件的 hook 顺序随数据变化，是 React 的硬错。 */
  const ticking = agents.length > 0
  const now = useSecond(ticking)
  const [showEnded, setShowEnded] = useState(false)
  /* 子代理按启动先后排，投影本身无序。 */
  const ordered = useMemo(() => [...agents].sort((left, right) => left.startedAt - right.startedAt), [agents])
  /* 已结束的倒过来：最近结束的在最上面。 */
  const endedOrdered = useMemo(() => [...ended].sort((left, right) => right.startedAt - left.startedAt), [ended])
  if (agents.length === 0 && ended.length === 0) {
    return null
  }
  const longest = ordered.reduce((carry, agent) => Math.max(carry, now - agent.startedAt), 0)
  return (
    <Section
      footer={
        /* 终态子代理不占活动列表的位置，但入口必须留着：点开就地展开，每一行照样点得开它的对话。 */
        ended.length > 0 ? (
          <div className="status-panel__ended" data-separated={agents.length > 0 || undefined}>
            <button
              aria-expanded={showEnded}
              className="status-panel__ended-row"
              data-agent-action="toggle-ended"
              onClick={() => setShowEnded((held) => !held)}
              type="button"
            >
              <CheckCircle2 aria-hidden className="status-panel__item-icon" />
              <span className="status-panel__git-label">已结束</span>
              <span className="status-panel__count">{ended.length}</span>
              <ChevronRight aria-hidden className="status-panel__ended-chevron" data-open={showEnded || undefined} />
            </button>
            {showEnded ? (
              <ul className="status-panel__list status-panel__scroll--agents" data-agent-list="ended">
                {endedOrdered.map((agent) => (
                  <AgentRowView agent={agent} key={agent.key} now={now} onOpen={onOpenAgent} />
                ))}
              </ul>
            ) : null}
          </div>
        ) : null
      }
      separated={separated}
      summary={() =>
        agents.length > 0 ? (
          <>
            <span className="status-panel__elapsed">{formatDuration(longest / 1000)}</span>
            <span aria-hidden className="status-panel__dot">
              ·
            </span>
            <span className="status-panel__count">{agents.length} 运行</span>
          </>
        ) : (
          <span className="status-panel__count">{ended.length} 已结束</span>
        )
      }
      title="智能体"
      value="agents"
    >
      <ul className="status-panel__list">
        {ordered.map((agent) => (
          <AgentRowView agent={agent} key={agent.key} now={now} onOpen={onOpenAgent} />
        ))}
      </ul>
    </Section>
  )
}

/* 终端（后台任务） */

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
  onStopTask,
  separated,
  tasks,
}: {
  /** 停一个运行中的后台作业；缺席（没有控制出口）时不画停止键。 */
  readonly onStopTask?: ((taskId: string) => void) | undefined
  readonly separated: boolean
  readonly tasks: readonly BackgroundTaskItem[]
}) {
  /* 同上：hook 必须走在「没有任务就返回 null」之前。 */
  const running = tasks.filter((task) => task.status === 'running' && task.startedAt !== undefined)
  const now = useSecond(running.length > 0)
  /* 没有后台任务就整格不提，同待办事项。 */
  if (tasks.length === 0) {
    return null
  }
  return (
    <Section
      separated={separated}
      summary={() => <span className="status-panel__count">{backgroundTaskProgressLabel(tasks)}</span>}
      title="后台任务"
      value="terminals"
    >
      <ul className="status-panel__list">
        {tasks.map((task) => (
          <li className="status-panel__item" data-status={task.status} key={task.taskId}>
            <span aria-label={BACKGROUND_STATUS_LABEL[task.status]} className="status-panel__glyph" role="img">
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
            {task.status === 'running' && onStopTask !== undefined ? (
              <button
                aria-label={`停止「${task.description}」`}
                className="status-panel__icon-button"
                data-task-action="stop"
                onClick={() => onStopTask(task.taskId)}
                title="停止"
                type="button"
              >
                <Square aria-hidden className="status-panel__icon" />
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </Section>
  )
}

const NO_AGENTS: readonly AgentRow[] = []

export function TaskPanelContent({
  backgroundTasks,
  endedAgents = NO_AGENTS,
  git,
  gitPicker,
  goal,
  onOpenAgent,
  onOpenReview,
  onPauseGoal,
  onResumeGoal,
  onStopTask,
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
  /** 点「智能体」里的一行：在右坞打开那个子代理的对话。 */
  readonly onOpenAgent?: OpenDelegateChannel | undefined
  /** 后台任务行尾的停止键。 */
  readonly onStopTask?: ((taskId: string) => void) | undefined
  readonly endedAgents?: readonly AgentRow[] | undefined
  readonly runningAgents?: readonly AgentRow[]
  readonly todos: readonly TodoItem[]
}) {
  const agents = runningAgents ?? []
  const showGoal = goal !== undefined && goal.status !== 'complete'
  const showAgents = agents.length > 0 || endedAgents.length > 0
  /* Git 是工具而不是进展：只要目录是 git 工作区就恒画。 */
  const showGit = git !== undefined

  /*
   * 每一格都是有事实才出现：空表连标题都不画（原来「待办事项 / 后台任务」常驻并各说一句「暂无」，那是两块永远空着的标题加两句废话）。
   * 展开与否按同一条规则：**有内容的才默认展开**。Git 是唯一例外 —— 它是常驻工具区，出现即展开。
   */
  const expanded = useMemo(
    () => [
      ...(showGit ? ['environment'] : []),
      ...(showGoal ? ['goal'] : []),
      ...(todos.length > 0 ? ['todo'] : []),
      ...(showAgents ? ['agents'] : []),
      ...(backgroundTasks.length > 0 ? ['terminals'] : []),
    ],
    [backgroundTasks.length, showAgents, showGit, showGoal, todos.length],
  )

  /*
   * 开合**受控**，不用 Accordion 的 defaultValue：每一格的数据都是异步到的（git 那一份要走一次 RPC），「该不该默认展开」在首帧常常还没有答案，
   * 而 defaultValue 只在挂载那一刻算一次 —— 晚到的那一格挂上来就是收起的。这里新出现的一格补进开着的名单（**只补一次**，之后人在它上面收起来就一直是收的）。
   */
  const [open, setOpen] = useState<string[]>([...expanded])
  const seen = useRef(new Set(expanded))
  useEffect(() => {
    const fresh = expanded.filter((value) => !seen.current.has(value))
    if (fresh.length === 0) {
      return
    }
    for (const value of fresh) {
      seen.current.add(value)
    }
    setOpen((held) => [...held, ...fresh])
  }, [expanded])

  return (
    <Accordion
      aria-label="任务与后台任务"
      className="status-panel"
      multiple
      onValueChange={(next) => {
        setOpen(next)
      }}
      value={open}
    >
      {git !== undefined ? <GitStatusSection git={git} onOpenReview={onOpenReview} picker={gitPicker} /> : null}
      {showGoal && goal !== undefined ? (
        <GoalSection goal={goal} onPause={() => onPauseGoal?.()} onResume={() => onResumeGoal?.()} separated={false} />
      ) : null}
      <TodoSection separated={showGit || showGoal} todos={todos} />
      {showAgents ? <AgentsSection agents={agents} ended={endedAgents} onOpenAgent={onOpenAgent} separated /> : null}
      <TerminalsSection onStopTask={onStopTask} separated tasks={backgroundTasks} />
    </Accordion>
  )
}

export function TodoPanel({
  goal: goalProp,
  onOpenReview,
  onPauseGoal: onPauseGoalProp,
  onResumeGoal: onResumeGoalProp,
  threadId,
}: {
  /** 这条对话此刻的目标（从 Core 的控件通道来）；缺席退回 Context 读（单测夹具用）。 */
  readonly goal?: SessionGoal | undefined
  readonly onOpenReview?: (() => void) | undefined
  /** 目标暂停 / 恢复的出口（与输入框那一排选择器同一条路）；缺席退回 Context store。 */
  readonly onPauseGoal?: (() => void) | undefined
  readonly onResumeGoal?: (() => void) | undefined
  readonly threadId: string
}) {
  const todos = useAssistantTodos(threadId)
  const backgroundTasks = useAssistantBackgroundTasks(threadId)
  const subagents = useAssistantSubagents(threadId)
  const timeline = useAssistantTimeline(threadId)
  const { controls, goal: heldGoal } = useOptionalThreadGoal(threadId)
  const goal = goalProp ?? heldGoal
  const agents = useMemo(() => agentRows(subagents, delegateCallsOf(timeline)), [subagents, timeline])
  /* Git 那一格的事实从 Context 读，不从 props 读：它由 review 贡献的 Provider 投下来，这样这一格与右侧「审查」面板读的是同一份快照，而这个组件不必认识 review。 */
  const git = useWorkspaceGitFacts()
  const openAgent = useOptionalDelegateChannel() ?? undefined
  const agentControls = useAgentControls()
  const stopTask = useMemo(
    () =>
      agentControls === null
        ? undefined
        : (taskId: string) => {
            /* 结果不另报：作业停下后引擎的下一次快照把它改成「已停止」；已经结束的交回 false，同样以快照为准。 */
            void agentControls.cancelBackgroundTask(threadId, taskId).catch(() => undefined)
          },
    [agentControls, threadId],
  )

  return (
    <TaskPanelContent
      backgroundTasks={backgroundTasks}
      endedAgents={agents.ended}
      git={git?.status}
      gitPicker={git?.picker}
      goal={goal}
      onOpenAgent={openAgent}
      onOpenReview={onOpenReview}
      onPauseGoal={
        onPauseGoalProp ??
        (() => {
          void controls?.selectControl(threadId, GOAL_CONTROL_ID, GOAL_PAUSED)
        })
      }
      onResumeGoal={
        onResumeGoalProp ??
        (() => {
          void controls?.selectControl(threadId, GOAL_CONTROL_ID, GOAL_RESUMED)
        })
      }
      onStopTask={stopTask}
      runningAgents={agents.running}
      todos={todos}
    />
  )
}
