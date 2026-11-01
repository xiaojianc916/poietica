import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@poietica/design-system'
import { CommandsToken, type Observable, useService } from '@poietica/ui-kernel'
import {
  Activity,
  ArrowRight,
  Bot,
  CheckCircle2,
  Ellipsis,
  FileDiff,
  Goal,
  ListChecks,
  Maximize2,
  Minimize2,
  SquareTerminal,
} from 'lucide-react'
import { type CSSProperties, type ReactNode, useCallback, useMemo, useState } from 'react'
import { useWorkspaceGitFacts } from '../../ui-api'
import type { SessionGoal } from '../shared/model/goal'
import {
  delegateCallsOf,
  useAgentControls,
  useAssistantBackgroundTasks,
  useAssistantSubagents,
  useAssistantTimeline,
  useAssistantTodos,
  useOptionalDelegateChannel,
} from '../timeline'
import './conversation-status-panel.css'
import { type StatusSummary, statusSummaryOf } from './todo/status-summary'
import { agentRows, TaskPanelContent } from './todo/todo-panel'

/* 用户手动选择的形态。null 交给 CSS 的容器查询裁决（auto），React 不读宽度。 */
export type SummaryPanelVariant = 'panel' | 'mini'
type DisplayMode = SummaryPanelVariant | 'auto'

/*
 * 面板形态偏好的唯一持有形状：读取是 Observable 那半边，写入用 set。宿主（setup 的 actions）
 * 把它交给对话表面，面板两侧（胶囊展开与收起按钮）都只经这一条写入路径。
 */
export type SummaryPanelPreference = Observable<SummaryPanelVariant | null> & {
  set(next: SummaryPanelVariant | null): void
}

interface ConversationStatusPanelLayoutStyle extends CSSProperties {
  readonly '--conversation-status-panel-width': string
  readonly '--conversation-status-panel-gap': string
}

/* 几何常量写在 .conversation-body 上：浮层本体与容器查询的让位规则都读这一份。 */
export const CONVERSATION_STATUS_PANEL_LAYOUT_STYLE: ConversationStatusPanelLayoutStyle = {
  '--conversation-status-panel-width': '320px',
  '--conversation-status-panel-gap': '16px',
}

/*
 * 状态面板（ZCode V4 的同一套壳）：收起态是右上角的单条摘要胶囊，展开态是 320px 的卡片；
 * auto 由 conversation-body 容器查询在 1280px 处切换，宽度不经过 JS。
 *
 * 没有内容就整块不挂载 —— 摘要链返回 null 就是「今天没有可报的状态」，不再画一个能点开的空面板。
 * 头部工具栏也不再提供开关：收起态点胶囊展开，展开态用右上角按钮收起。
 */
export function ConversationStatusPanel({
  goal,
  onOpenReview,
  onPauseGoal,
  onResumeGoal,
  onVariantChange,
  threadId,
  variant,
}: {
  /** 这条对话此刻的目标；缺席不进摘要，也不进面板。 */
  readonly goal?: SessionGoal | undefined
  readonly onOpenReview?: (() => void) | undefined
  /** 目标暂停 / 恢复的出口（与输入框那一排选择器同一条路）。 */
  readonly onPauseGoal?: (() => void) | undefined
  readonly onResumeGoal?: (() => void) | undefined
  readonly onVariantChange?: ((variant: SummaryPanelVariant | null) => void) | undefined
  readonly threadId: string
  /** null = auto（CSS 裁决），panel = 始终展开，mini = 始终收起。 */
  readonly variant: SummaryPanelVariant | null
}) {
  const todos = useAssistantTodos(threadId)
  const backgroundTasks = useAssistantBackgroundTasks(threadId)
  const subagents = useAssistantSubagents(threadId)
  const timeline = useAssistantTimeline(threadId)
  const agents = useMemo(() => agentRows(subagents, delegateCallsOf(timeline)), [subagents, timeline])
  /* Git 那一格的事实从 Context 读，不从 props 读：它由 review 贡献的 Provider 投下来，这样这一格与右侧「审查」面板读的是同一份快照，而这个组件不必认识 review。 */
  const git = useWorkspaceGitFacts()
  const openAgent = useOptionalDelegateChannel() ?? undefined
  const agentControls = useAgentControls()
  const commands = useService(CommandsToken)
  const runningTaskCount = backgroundTasks.filter((task) => task.status === 'running').length

  /*
   * 「提交或推送」那一行开审查面：审查面由 review 贡献，打开它走命令 id（跨功能只经贡献点 /
   * 命令协作，conversation 不 import review）。命令失败由 CommandService 自己记账（logger +
   * 横幅），这里再兜一层，不让它冒泡。
   */
  const openReview = useCallback(() => {
    if (onOpenReview !== undefined) {
      onOpenReview()
      return
    }
    void commands.execute('review.openChanges').catch(() => undefined)
  }, [commands, onOpenReview])

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

  const summary = statusSummaryOf({
    goal,
    git: git?.status,
    runningAgents: agents.running.length,
    runningTasks: runningTaskCount,
    todos,
  })

  if (summary === null) {
    return null
  }

  const mode: DisplayMode = variant ?? 'auto'
  return (
    <aside
      aria-label="状态"
      className="conversation-status-panel"
      data-display-mode={mode}
      data-state={mode === 'mini' ? 'collapsed' : 'expanded'}
    >
      <div className="conversation-status-panel__surface">
        {mode === 'mini' ? null : (
          <div className="conversation-status-panel__panel">
            <PanelControls mode={mode} onVariantChange={onVariantChange} />
            <div className="conversation-status-panel__scroll">
              <TaskPanelContent
                backgroundTasks={backgroundTasks}
                endedAgents={agents.ended}
                git={git?.status}
                gitPicker={git?.picker}
                goal={goal}
                key={threadId}
                onOpenAgent={openAgent}
                onOpenReview={openReview}
                onPauseGoal={onPauseGoal}
                onResumeGoal={onResumeGoal}
                onStopTask={stopTask}
                runningAgents={agents.running}
                todos={todos}
              />
            </div>
          </div>
        )}
        {mode === 'panel' ? null : (
          <div className="conversation-status-panel__mini">
            <StatusSummaryRow
              onExpand={() => {
                onVariantChange?.('panel')
              }}
              summary={summary}
            />
          </div>
        )}
      </div>
    </aside>
  )
}

function PanelControls({
  mode,
  onVariantChange,
}: {
  readonly mode: DisplayMode
  readonly onVariantChange?: ((variant: SummaryPanelVariant | null) => void) | undefined
}) {
  /* 菜单开合受控：点选后由这里关掉，不依赖菜单库内部的关闭路径；同值再选一次也能收起。 */
  const [menuOpen, setMenuOpen] = useState(false)

  return (
    <div className="conversation-status-panel__controls">
      <TooltipProvider delay={150}>
        <DropdownMenu onOpenChange={setMenuOpen} open={menuOpen}>
          {/* 提示用 CSS 画在按钮上：Tooltip 触发器与 Menu 触发器抢同一个按钮的指针事件时菜单可能打不开。 */}
          <DropdownMenuTrigger
            aria-label="状态面板展开策略"
            className="conversation-status-panel__control"
            data-tooltip="状态面板展开策略"
            type="button"
          >
            <Ellipsis aria-hidden />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44" side="bottom">
            <DropdownMenuRadioGroup value={mode}>
              <DropdownMenuRadioItem
                onClick={() => {
                  setMenuOpen(false)
                  onVariantChange?.(null)
                }}
                value="auto"
              >
                自动展开
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <Tooltip>
          <TooltipTrigger
            aria-label="收起为胶囊"
            className="conversation-status-panel__control"
            onClick={() => {
              onVariantChange?.('mini')
            }}
            type="button"
          >
            <Minimize2 aria-hidden />
          </TooltipTrigger>
          <TooltipContent side="left" sideOffset={4}>
            收起为胶囊
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  )
}

function StatusSummaryRow({ onExpand, summary }: { readonly onExpand: () => void; readonly summary: StatusSummary }) {
  return (
    <TooltipProvider delay={150}>
      <Tooltip>
        <TooltipTrigger
          aria-label="展开状态"
          className="conversation-status-panel__summary"
          onClick={onExpand}
          type="button"
        >
          <span className="conversation-status-panel__summary-icon">
            <span className="conversation-status-panel__summary-glyph">{summaryGlyph(summary)}</span>
            <Maximize2 aria-hidden className="conversation-status-panel__summary-expand" />
          </span>
          <StatusSummaryBody summary={summary} />
        </TooltipTrigger>
        <TooltipContent side="left" sideOffset={4}>
          展开状态
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

function StatusSummaryBody({ summary }: { readonly summary: StatusSummary }) {
  switch (summary.kind) {
    case 'git':
      return (
        <>
          <span className="conversation-status-panel__summary-title">更改</span>
          <span className="conversation-status-panel__summary-added">+{summary.added}</span>
          <span className="conversation-status-panel__summary-removed">-{summary.removed}</span>
        </>
      )
    case 'todo-progress':
      return (
        <>
          <span className="conversation-status-panel__summary-title">待办事项</span>
          <span className="conversation-status-panel__summary-count">
            {summary.done}/{summary.total}
          </span>
        </>
      )
    case 'running':
      return (
        <span className="conversation-status-panel__summary-title">
          {summary.count} {summary.agents > 0 ? '运行' : '后台'}
        </span>
      )
    default:
      return <span className="conversation-status-panel__summary-title">{summary.title}</span>
  }
}

function summaryGlyph(summary: StatusSummary): ReactNode {
  switch (summary.kind) {
    case 'todo-current':
      return <ArrowRight aria-hidden />
    case 'goal':
      return <Goal aria-hidden />
    case 'git':
      return <FileDiff aria-hidden />
    case 'todo-completed':
      return <CheckCircle2 aria-hidden />
    case 'todo-progress':
      return <ListChecks aria-hidden />
    case 'running':
      if (summary.agents > 0 && summary.tasks > 0) {
        return <Activity aria-hidden />
      }
      return summary.agents > 0 ? <Bot aria-hidden /> : <SquareTerminal aria-hidden />
  }
}
