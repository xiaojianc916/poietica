import { type LayoutService, useNavigation, useObservable } from '@poietica/ui-kernel'
import { PanelRight } from 'lucide-react'
import type { ReactNode } from 'react'

/*
 * 会话页右上角的辅助面板开关。位置不在这只按钮上：栅格右上角那一格由 workbench 的包装层
 * （.workspace-shell__conversation-control[data-slot]）持有，组件只画按钮本体。
 *
 * 状态面板不在页头：它收在对话画布右上角，收起态点摘要胶囊展开（ZCode V4）。
 */

const controlClass =
  'flex size-6 shrink-0 items-center justify-center rounded-md opacity-60 hover:bg-control-hover hover:opacity-100'

/* 只在对话页且线程号非空时画；判据来自路由，组件不收「是不是对话页」这个 prop。 */
function currentThreadId(surface: string, params: Readonly<Record<string, string>>): string | null {
  if (surface !== 'conversation.thread') return null
  const threadId = String(params.threadId ?? '')
  return threadId === '' ? null : threadId
}

/** 对话里它管这条对话的右栏（owner = 这条对话）；设置页那一枚由 workbench 自己画。 */
export function ConversationAuxiliaryToggle({ layout }: { readonly layout: LayoutService }): ReactNode {
  const { route } = useNavigation()
  const threadId = currentThreadId(route.surface, route.params)
  const state = useObservable(layout)

  if (threadId === null) return null

  /* 开关只认这条对话自己那一份：在场 = 前台（就是这条对话）的坞开着。 */
  const open = state.right.open && state.auxiliary.owner === threadId
  const label = open ? '收起辅助面板' : '打开辅助面板'
  return (
    <button
      aria-controls="workspace-auxiliary-panel"
      aria-expanded={open}
      aria-label={label}
      className={controlClass}
      onClick={() => {
        layout.setDockOpen(threadId, !open)
      }}
      type="button"
    >
      <PanelRight aria-hidden />
    </button>
  )
}
