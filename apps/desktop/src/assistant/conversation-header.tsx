import { ListTodo, PanelRight } from 'lucide-react'
import { useWorkspaceLayoutState, workspaceLayoutStore } from '../shell/workspace-layout-store'
import './conversation-header.css'

const controlClass =
  'flex size-6 shrink-0 items-center justify-center rounded-md opacity-60 hover:bg-current/10 hover:opacity-100 aria-expanded:bg-current/10 aria-expanded:opacity-100'

/*
 * 会话页头右角的两枚开关：独立任务弹窗与辅助面板。
 *
 * 它们只写 workspaceLayoutStore 的归属意图 —— 外壳几何的唯一所有者 —— 不认识
 * 任何面板内部状态。座位固定在页头，面板开合不搬动它们。
 */
export function ConversationHeader({ conversationId }: { readonly conversationId: string }) {
  const { auxiliaryThread, todoThread } = useWorkspaceLayoutState()
  const todoOpen = todoThread === conversationId
  const auxiliaryOpen = auxiliaryThread === conversationId
  const todoLabel = todoOpen ? '关闭任务弹窗' : '打开任务弹窗'
  const auxiliaryLabel = auxiliaryOpen ? '收起辅助面板' : '打开辅助面板'

  return (
    <header className="conversation-header" data-assistant-skin>
      <div className="flex items-center gap-1">
        <button
          aria-controls="conversation-todo-panel"
          aria-expanded={todoOpen}
          aria-label={todoLabel}
          className={controlClass}
          id="conversation-todo-trigger"
          onClick={() => {
            workspaceLayoutStore.setTodoThread(todoOpen ? null : conversationId)
          }}
          title={todoLabel}
          type="button"
        >
          <ListTodo aria-hidden className="size-4" />
        </button>
        <button
          aria-controls="workspace-auxiliary-panel"
          aria-expanded={auxiliaryOpen}
          aria-label={auxiliaryLabel}
          className={controlClass}
          onClick={() => {
            workspaceLayoutStore.setAuxiliaryThread(auxiliaryOpen ? null : conversationId)
          }}
          title={auxiliaryLabel}
          type="button"
        >
          <PanelRight aria-hidden className="size-4" />
        </button>
      </div>
    </header>
  )
}
