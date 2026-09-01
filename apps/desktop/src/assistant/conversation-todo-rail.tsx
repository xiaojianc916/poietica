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
import './conversation-todo-rail.css'

type RailStyle = CSSProperties & Record<`--${string}`, string>

const RAIL_STYLE: RailStyle = {
  '--conversation-todo-width': `${WORKSPACE_LAYOUT.todo.width}px`,
}

/**
 * 任务面板那一列。
 *
 * 归属与开合是 workspaceLayoutStore 的意图；挤压还是覆盖是几何事实，由内容行的
 * 实测宽度过 resolvePanelMode 得出 —— 与辅助列同一条判据。行宽不随开合变化，
 * 所以两种形态之间没有回路。两种形态是同一段 DOM，切换不打断补间。
 */
export function ConversationTodoRail({ threadId }: { readonly threadId: string }) {
  const { todoThread } = useWorkspaceLayoutState()
  const open = todoThread === threadId
  const [mode, setMode] = useState<PanelMode>('dock')
  const rail = useRef<HTMLElement | null>(null)

  useLayoutEffect(() => {
    const region = rail.current?.parentElement ?? null

    if (region === null) {
      return undefined
    }

    const measure = () => {
      const next = resolvePanelMode(region.clientWidth, WORKSPACE_LAYOUT.todo.width)
      setMode((current) => (current === next ? current : next))
    }

    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(region)

    return () => {
      observer.disconnect()
    }
  }, [])

  const close = useCallback(() => {
    workspaceLayoutStore.setTodoThread(null)
  }, [])

  /* 覆盖态是模态形态，所以收 Escape；挤压态是一列版式，不该被按键关掉。 */
  useEffect(() => {
    if (!open || mode !== 'overlay') {
      return undefined
    }

    const dismiss = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        close()
      }
    }

    window.addEventListener('keydown', dismiss)

    return () => {
      window.removeEventListener('keydown', dismiss)
    }
  }, [close, mode, open])

  return (
    <aside
      className="conversation-todo"
      data-assistant-skin
      data-mode={mode}
      data-open={open ? 'true' : 'false'}
      id="conversation-todo-panel"
      inert={!open}
      ref={rail}
      style={RAIL_STYLE}
    >
      <button
        aria-label="关闭任务"
        className="conversation-todo__scrim"
        onClick={close}
        tabIndex={-1}
        type="button"
      />
      <div className="conversation-todo__panel">
        <TodoPanel onClose={close} threadId={threadId} />
      </div>
    </aside>
  )
}
