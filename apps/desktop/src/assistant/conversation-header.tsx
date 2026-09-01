import { ListTodo, PanelRight } from 'lucide-react'
import { useWorkspaceLayoutState, workspaceLayoutStore } from '../shell/workspace-layout-store'
import './conversation-header.css'

const controlClass =
  'workspace-shell__conversation-control flex size-6 shrink-0 items-center justify-center rounded-md opacity-60 hover:bg-current/10 hover:opacity-100 aria-expanded:bg-current/10 aria-expanded:opacity-100'

/** 会话页头只提供内容区的固定高度与底色；控件由外壳栅格定位。 */
export function ConversationHeader() {
  return <div aria-hidden="true" className="conversation-header" data-assistant-skin />
}

/**
 * 两枚控件始终处在同一个 React 树位置。辅助面板开合只改变栅格几何，
 * 不通过条件渲染搬运或重建按钮。
 */
export function ConversationControls({ conversationId }: { readonly conversationId: string }) {
  const { auxiliaryThread, todoThread } = useWorkspaceLayoutState()
  const todoOpen = todoThread === conversationId
  const auxiliaryOpen = auxiliaryThread === conversationId
  const todoLabel = todoOpen ? '关闭任务弹窗' : '打开任务弹窗'
  const auxiliaryLabel = auxiliaryOpen ? '收起辅助面板' : '打开辅助面板'

  return (
    <>
      <button
        aria-controls="conversation-todo-panel"
        aria-expanded={todoOpen}
        aria-label={todoLabel}
        className={[controlClass, 'workspace-shell__todo-toggle'].join(' ')}
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
        className={[controlClass, 'workspace-shell__auxiliary-toggle'].join(' ')}
        onClick={() => {
          workspaceLayoutStore.setAuxiliaryThread(auxiliaryOpen ? null : conversationId)
        }}
        title={auxiliaryLabel}
        type="button"
      >
        <PanelRight aria-hidden className="size-4" />
      </button>
    </>
  )
}
