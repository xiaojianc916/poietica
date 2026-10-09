import { CommandsToken, useService } from '@poietica/ui-kernel'
import { Minimize2 } from 'lucide-react'
import { type CSSProperties, useCallback } from 'react'
import type { SessionGoal } from '../../agent/goal'
import './conversation-todo-popover.css'
import { TodoPanel } from './todo-panel'

interface ConversationTodoLayoutStyle extends CSSProperties {
  readonly '--conversation-todo-width': string
  readonly '--conversation-todo-gap': string
}

/*
 * 浮层几何（legacy 的 CONVERSATION_TODO_LAYOUT_STYLE，数值来自 WORKSPACE_LAYOUT.todo）：
 * 卡片宽 320、距画布上缘 / 右缘各 12。宿主把它写在 .conversation-body 上（见
 * AssistantSurface），浮层本体与 @container 那条让位规则都读这一份自定义属性。
 */
export const CONVERSATION_TODO_LAYOUT_STYLE: ConversationTodoLayoutStyle = {
  '--conversation-todo-width': '320px',
  '--conversation-todo-gap': '12px',
}

/*
 * 展开态那一半：开合由宿主持有（页头右栏开关左边那枚图标钮），这里只画卡片。
 *
 * 收起态就是那枚图标钮本身，所以这里不再渲染 mini —— 同一件事只有一条写入路径，
 * 不会出现「页头说收起了、浮层还说展开」。
 * 收起钮与滚动区是**兄弟**而不是父子：它钉在卡片上，不跟着面板内容滚走。
 */
export function ConversationTodoPopover({
  expanded,
  goal,
  onCollapse,
  onOpenReview,
  onPauseGoal,
  onResumeGoal,
  threadId,
}: {
  readonly expanded: boolean
  /** 这条对话此刻的目标（从 Core 的控件通道来）；缺席整格不画。 */
  readonly goal?: SessionGoal | undefined
  readonly onCollapse: () => void
  readonly onOpenReview?: (() => void) | undefined
  readonly onPauseGoal?: (() => void) | undefined
  readonly onResumeGoal?: (() => void) | undefined
  readonly threadId: string
}) {
  const commands = useService(CommandsToken)
  /*
   * 「提交或推送」那一行开审查面：legacy 是 auxiliaryPanel.openLauncherPane('review')，
   * 新架构里审查面由 review 贡献，打开它走命令 id（跨功能只经贡献点 / 命令协作，
   * conversation 不 import review）。命令失败由 CommandService 自己记账（logger + toast），
   * 这里再兜一层，不让它冒泡。
   */
  const openReview = useCallback(() => {
    if (onOpenReview !== undefined) {
      onOpenReview()
      return
    }
    void commands.execute('review.openChanges').catch(() => undefined)
  }, [commands, onOpenReview])

  if (!expanded) {
    return null
  }
  return (
    <aside
      aria-label="任务与后台任务"
      className="conversation-todo-popover"
      data-assistant-skin
      data-open="true"
      id="conversation-todo-panel"
    >
      <div className="conversation-todo-popover__surface">
        <button
          aria-label="收起状态面板"
          className="conversation-todo-popover__collapse"
          onClick={onCollapse}
          type="button"
        >
          <Minimize2 aria-hidden className="conversation-todo-popover__collapse-icon" />
        </button>
        <div className="conversation-todo-popover__scroll">
          <TodoPanel
            goal={goal}
            onOpenReview={openReview}
            onPauseGoal={onPauseGoal}
            onResumeGoal={onResumeGoal}
            threadId={threadId}
          />
        </div>
      </div>
    </aside>
  )
}
