import { ListTodo, PanelRight } from 'lucide-react'

import './conversation-header.css'

const controlClass =
  'workspace-shell__conversation-control flex size-6 shrink-0 items-center justify-center rounded-md opacity-60 hover:bg-current/10 hover:opacity-100'

/** 会话页头只提供内容区的固定高度与底色；控件由外壳栅格定位。 */
export function ConversationHeader() {
  return <div aria-hidden="true" className="conversation-header" data-assistant-skin />
}

export function ConversationControls({
  todoOpen,
  auxiliaryOpen,
  onToggleTodo,
  onToggleAuxiliary,
}: {
  readonly todoOpen: boolean
  readonly auxiliaryOpen: boolean
  readonly onToggleTodo: () => void
  readonly onToggleAuxiliary: () => void
}) {
  const todoLabel = todoOpen ? '关闭任务弹窗' : '打开任务弹窗'
  const auxiliaryLabel = auxiliaryOpen ? '收起辅助面板' : '打开辅助面板'

  return (
    <>
      <button
        aria-controls="conversation-todo-panel"
        aria-expanded={todoOpen}
        aria-label={todoLabel}
        className={[
          controlClass,
          'workspace-shell__todo-toggle aria-expanded:bg-current/10 aria-expanded:opacity-100',
        ].join(' ')}
        id="conversation-todo-trigger"
        onClick={onToggleTodo}
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
        onClick={onToggleAuxiliary}
        title={auxiliaryLabel}
        type="button"
      >
        <PanelRight aria-hidden className="size-4" />
      </button>
    </>
  )
}
