import { TodoPanel } from '@poietica/surfaces'
import { WORKSPACE_LAYOUT } from '@poietica/workspace'
import type { CSSProperties } from 'react'
import { useWorkspaceLayoutState } from '../shell/workspace-layout-store'
import './conversation-todo-popover.css'

interface TodoPopoverStyle extends CSSProperties {
  readonly '--conversation-todo-width': string
  readonly '--conversation-todo-gap': string
}

const POPOVER_STYLE: TodoPopoverStyle = {
  '--conversation-todo-width': String(WORKSPACE_LAYOUT.todo.width).concat('px'),
  '--conversation-todo-gap': String(WORKSPACE_LAYOUT.todo.gap).concat('px'),
}

export function ConversationTodoPopover({ threadId }: { readonly threadId: string }) {
  const { todoThread } = useWorkspaceLayoutState()
  const open = todoThread === threadId

  return (
    <aside
      aria-hidden={!open}
      aria-label="任务与后台任务"
      className="conversation-todo-popover"
      data-assistant-skin
      data-open={open ? 'true' : 'false'}
      id="conversation-todo-panel"
      inert={!open}
      style={POPOVER_STYLE}
    >
      <div className="conversation-todo-popover__surface">
        <TodoPanel threadId={threadId} />
      </div>
    </aside>
  )
}
