import { type LayoutService, type Observable, useNavigation, useObservable } from '@poietica/ui-kernel'
import { ListTodo, PanelRight } from 'lucide-react'
import type { ReactNode } from 'react'

/*
 * 会话页右上角的两枚开关。位置不在这两只按钮上：栅格右上角那两格由 workbench 的包装层
 * （.workspace-shell__conversation-control[data-slot]）持有，组件只画按钮本体。
 */

const controlClass =
  'flex size-6 shrink-0 items-center justify-center rounded-md opacity-60 hover:bg-control-hover hover:opacity-100'

/** 任务浮层状态是可变值（setup 里的 createValue）：读走 Observable 那半边，写用 set。 */
export type ConversationTodoThread = Observable<string | null> & { set(next: string | null): void }

/* 只在对话页且线程号非空时画；判据来自路由，组件不收「是不是对话页」这个 prop。 */
function currentThreadId(surface: string, params: Readonly<Record<string, string>>): string | null {
  if (surface !== 'conversation.thread') return null
  const threadId = String(params.threadId ?? '')
  return threadId === '' ? null : threadId
}

/** 与右栏开关同形同尺寸，由外壳把它摆在它左边。 */
export function ConversationTodoToggle({ todoThread }: { readonly todoThread: ConversationTodoThread }): ReactNode {
  const { route } = useNavigation()
  const threadId = currentThreadId(route.surface, route.params)
  const todoOpen = useObservable(todoThread)

  if (threadId === null) return null

  const open = todoOpen === threadId
  const label = open ? '收起任务面板' : '打开任务面板'
  return (
    <button
      aria-controls="conversation-todo-panel"
      aria-expanded={open}
      aria-label={label}
      className={controlClass}
      onClick={() => {
        todoThread.set(open ? null : threadId)
      }}
      type="button"
    >
      <ListTodo aria-hidden className="size-4" />
    </button>
  )
}

/** 对话里它管这条对话的右栏（owner = 这条对话）；设置页那一枚由 workbench 自己画。 */
export function ConversationAuxiliaryToggle({ layout }: { readonly layout: LayoutService }): ReactNode {
  const { route } = useNavigation()
  const threadId = currentThreadId(route.surface, route.params)
  const state = useObservable(layout)

  if (threadId === null) return null

  const open = state.auxiliary.owner === threadId
  const label = open ? '收起辅助面板' : '打开辅助面板'
  return (
    <button
      aria-controls="workspace-auxiliary-panel"
      aria-expanded={open}
      aria-label={label}
      className={controlClass}
      onClick={() => {
        layout.setAuxiliaryOwner(open ? null : threadId)
      }}
      type="button"
    >
      <PanelRight aria-hidden className="size-4" />
    </button>
  )
}
