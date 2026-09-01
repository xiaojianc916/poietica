import { TodoPanel } from '@poietica/surfaces'
import { type PanelMode, resolvePanelMode, WORKSPACE_LAYOUT } from '@poietica/workspace'
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { useWorkspaceLayoutState, workspaceLayoutStore } from '../shell/workspace-layout-store'
import './conversation-todo-popover.css'

interface TodoPopoverStyle extends CSSProperties {
  readonly '--conversation-todo-width': string
  readonly '--conversation-todo-gap': string
}

const POPOVER_STYLE: TodoPopoverStyle = {
  '--conversation-todo-width': String(WORKSPACE_LAYOUT.todo.width).concat('px'),
  '--conversation-todo-gap': String(WORKSPACE_LAYOUT.todo.gap).concat('px'),
}

const TRIGGER_ID = 'conversation-todo-trigger'

export function ConversationTodoPopover({ threadId }: { readonly threadId: string }) {
  const { todoThread } = useWorkspaceLayoutState()
  const open = todoThread === threadId
  const [mode, setMode] = useState<PanelMode>('dock')
  const popover = useRef<HTMLElement | null>(null)

  useLayoutEffect(() => {
    const region = popover.current?.parentElement ?? null
    if (region === null) {
      return undefined
    }

    const measure = () => {
      const reserve = WORKSPACE_LAYOUT.todo.width + WORKSPACE_LAYOUT.todo.gap * 2
      const next = resolvePanelMode(region.clientWidth, reserve)
      setMode((current) => (current === next ? current : next))
    }

    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(region)
    return () => observer.disconnect()
  }, [])

  const close = useCallback(() => {
    workspaceLayoutStore.setTodoThread(null)
  }, [])

  useEffect(() => {
    if (!open) {
      return undefined
    }

    const dismissOutside = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node)) {
        return
      }
      const trigger = document.getElementById(TRIGGER_ID)
      if (popover.current?.contains(target) || trigger?.contains(target)) {
        return
      }
      close()
    }

    const dismissWithKeyboard = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return
      }
      event.preventDefault()
      close()
      queueMicrotask(() => document.getElementById(TRIGGER_ID)?.focus())
    }

    document.addEventListener('pointerdown', dismissOutside, true)
    window.addEventListener('keydown', dismissWithKeyboard)
    return () => {
      document.removeEventListener('pointerdown', dismissOutside, true)
      window.removeEventListener('keydown', dismissWithKeyboard)
    }
  }, [close, open])

  return (
    <aside
      aria-hidden={!open}
      aria-label="任务"
      className="conversation-todo-popover"
      data-assistant-skin
      data-mode={mode}
      data-open={open ? 'true' : 'false'}
      id="conversation-todo-panel"
      inert={!open}
      ref={popover}
      style={POPOVER_STYLE}
    >
      <div className="conversation-todo-popover__surface">
        <TodoPanel threadId={threadId} />
      </div>
    </aside>
  )
}
