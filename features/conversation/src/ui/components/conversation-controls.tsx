import { type LayoutService, type Observable, useNavigation, useObservable } from '@poietica/ui-kernel'
import { ListTodo, PanelRight } from 'lucide-react'
import type { ReactNode } from 'react'

/*
 * 会话页右上角的两枚开关。**迁移自** legacy
 * apps/desktop/src/assistant/conversation-header.tsx 的 TodoToggle / AuxiliaryToggle。
 *
 * 位置不在这两只按钮上：栅格右上角那两格由 workbench 的包装层
 * （.workspace-shell__conversation-control[data-slot]）持有 —— legacy 的 controlClass 里带
 * workspace-shell__conversation-control，是因为那时按钮自己站进栅格；新架构里位置归外壳，
 * 组件只画按钮本体，所以类名只留视觉那一段。
 *
 * 两枚都只在对话页出现（legacy 的 workspace.tsx：main.controls 判 activeConversationId
 * 非空），判据来自路由，组件不另外收「是不是对话页」这个 prop。
 */

const controlClass =
  'flex size-6 shrink-0 items-center justify-center rounded-md opacity-60 hover:bg-control-hover hover:opacity-100'

/** 任务浮层状态是可变值（setup 里的 createValue）：读走 Observable 那半边，写用 set。 */
export type ConversationTodoThread = Observable<string | null> & { set(next: string | null): void }

/* 只有对话页、且线程号非空时才画；其余表面（入口页 / 设置等）交回 null。 */
function currentThreadId(surface: string, params: Readonly<Record<string, string>>): string | null {
  if (surface !== 'conversation.thread') return null
  const threadId = String(params.threadId ?? '')
  return threadId === '' ? null : threadId
}

/** 任务与后台任务面板的开关：与右栏开关同形同尺寸，由外壳把它摆在它左边。 */
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

/**
 * 辅助面板开关。对话里它管那条对话的右栏（owner = 这条对话），
 * 设置页那一枚由 workbench 自己画（legacy 是 SettingsAuxiliaryControl）。
 */
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
