import type { GitBranchPickerProps, WorkspaceGitStatus } from '@poietica/conversation/surface'
import { TodoPanel } from '@poietica/conversation/surface'
import { WORKSPACE_LAYOUT } from '@poietica/workspace'
import { Minimize2 } from 'lucide-react'
import type { CSSProperties } from 'react'

import './conversation-todo-popover.css'

interface ConversationTodoLayoutStyle extends CSSProperties {
  readonly '--conversation-todo-width': string
  readonly '--conversation-todo-gap': string
}

export const CONVERSATION_TODO_LAYOUT_STYLE: ConversationTodoLayoutStyle = {
  '--conversation-todo-width': String(WORKSPACE_LAYOUT.todo.width).concat('px'),
  '--conversation-todo-gap': String(WORKSPACE_LAYOUT.todo.gap).concat('px'),
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
  git,
  gitPicker,
  onCollapse,
  onOpenReview,
  threadId,
}: {
  readonly expanded: boolean
  readonly git?: WorkspaceGitStatus | undefined
  readonly gitPicker?: GitBranchPickerProps | undefined
  readonly onCollapse: () => void
  readonly onOpenReview?: (() => void) | undefined
  readonly threadId: string
}) {
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
            git={git}
            gitPicker={gitPicker}
            onOpenReview={onOpenReview}
            threadId={threadId}
          />
        </div>
      </div>
    </aside>
  )
}
