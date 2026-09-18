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
      title={label}
      type="button"
    >
      <PanelRight aria-hidden className="size-4" />
    </button>
  )
}

function TodoToggle({
  todoOpen,
  onToggleTodo,
}: {
  readonly todoOpen: boolean
  readonly onToggleTodo: () => void
}) {
  const label = todoOpen ? '关闭任务弹窗' : '打开任务弹窗'

  return (
    <button
      aria-controls="conversation-todo-panel"
      aria-expanded={todoOpen}
      aria-label={label}
      className={[
        controlClass,
        'workspace-shell__todo-toggle aria-expanded:bg-control-hover aria-expanded:opacity-100',
      ].join(' ')}
      id="conversation-todo-trigger"
      onClick={onToggleTodo}
      title={label}
      type="button"
    >
      <ListTodo aria-hidden className="size-4" />
    </button>
  )
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
  return (
    <>
      <TodoToggle onToggleTodo={onToggleTodo} todoOpen={todoOpen} />

      <AuxiliaryToggle auxiliaryOpen={auxiliaryOpen} onToggleAuxiliary={onToggleAuxiliary} />
    </>
  )
}
