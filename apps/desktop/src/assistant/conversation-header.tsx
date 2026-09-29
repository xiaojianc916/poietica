import { ListTodo, PanelRight } from 'lucide-react'

import './conversation-header.css'

const controlClass =
  'workspace-shell__conversation-control flex size-6 shrink-0 items-center justify-center rounded-md opacity-60 hover:bg-control-hover hover:opacity-100'

/** 会话页头只提供内容区的固定高度与底色；控件由外壳栅格定位。 */
export function ConversationHeader() {
  return <div aria-hidden="true" className="conversation-header" data-assistant-skin />
}

/**
 * 辅助面板开关。外壳把它摆在栅格右上角，两个界面共用同一枚：对话里它管那条对话的
 * 右栏，设置里它管技能文档那一格。
 */
export function AuxiliaryToggle({
  auxiliaryOpen,
  onToggleAuxiliary,
}: {
  readonly auxiliaryOpen: boolean
  readonly onToggleAuxiliary: () => void
}) {
  const label = auxiliaryOpen ? '收起辅助面板' : '打开辅助面板'

  return (
    <button
      aria-controls="workspace-auxiliary-panel"
      aria-expanded={auxiliaryOpen}
      aria-label={label}
      className={[controlClass, 'workspace-shell__auxiliary-toggle'].join(' ')}
      onClick={onToggleAuxiliary}
      type="button"
    >
      <PanelRight aria-hidden className="size-4" />
    </button>
  )
}

/** 任务与后台任务面板的开关：与右栏开关同形同尺寸，摆在它左边。 */
export function TodoToggle({
  onToggleTodo,
  todoOpen,
}: {
  readonly onToggleTodo: () => void
  readonly todoOpen: boolean
}) {
  const label = todoOpen ? '收起任务面板' : '打开任务面板'

  return (
    <button
      aria-controls="conversation-todo-panel"
      aria-expanded={todoOpen}
      aria-label={label}
      className={[controlClass, 'workspace-shell__todo-control'].join(' ')}
      onClick={onToggleTodo}
      type="button"
    >
      <ListTodo aria-hidden className="size-4" />
    </button>
  )
}

export function ConversationControls({
  auxiliaryOpen,
  onToggleAuxiliary,
  onToggleTodo,
  todoOpen,
}: {
  readonly auxiliaryOpen: boolean
  readonly onToggleAuxiliary: () => void
  readonly onToggleTodo: () => void
  readonly todoOpen: boolean
}) {
  return (
    <>
      <TodoToggle onToggleTodo={onToggleTodo} todoOpen={todoOpen} />

      <AuxiliaryToggle auxiliaryOpen={auxiliaryOpen} onToggleAuxiliary={onToggleAuxiliary} />
    </>
  )
}
