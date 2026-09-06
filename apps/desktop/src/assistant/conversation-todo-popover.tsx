import { TodoPanel } from '@poietica/conversation/surface'
import { WORKSPACE_LAYOUT } from '@poietica/workspace'
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

export function ConversationTodoPopover({
  threadId,
  open,
}: {
  readonly threadId: string
  readonly open: boolean
}) {
  return (
    <aside
      aria-hidden={!open}
      aria-label="任务与后台任务"
      className="conversation-todo-popover"
      data-assistant-skin
      data-open={open ? 'true' : 'false'}
      id="conversation-todo-panel"
      inert={!open}
    >
      <div className="conversation-todo-popover__surface">
        <TodoPanel threadId={threadId} />
      </div>
    </aside>
  )
}
