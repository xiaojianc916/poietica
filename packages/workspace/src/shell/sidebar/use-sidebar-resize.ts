import { type KeyboardEvent, type MouseEvent, type PointerEvent, useEffect, useRef } from 'react'

import { workspaceLayoutStore } from '../workspace-layout-store'

export interface SidebarResizeOptions {
  readonly width: number
  readonly min: number
  readonly max: number
  readonly onResize: (width: number) => void
  readonly onCollapse: () => void
}

interface SidebarDragSession {
  readonly pointerId: number
  readonly element: HTMLHRElement
  readonly startX: number
  readonly startWidth: number
  /* 最后已知的指针位置：收尾时用它判定指针是否还在条上。 */
  point: { readonly x: number; readonly y: number }
}

/*
 * 指针是否还在条上，按几何自己算。捕获期间浏览器的 :hover 按规范被覆盖到捕获
 * 元素上（Pointer Events L3 setPointerCapture），所以收尾态不能问浏览器。
 */
function isPointerOver(element: HTMLHRElement, point: { x: number; y: number }): boolean {
  const rect = element.getBoundingClientRect()

  return (
    point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom
  )
}

export interface SidebarResizeBindings {
  readonly onDoubleClick: (event: MouseEvent<HTMLHRElement>) => void
  readonly onKeyDown: (event: KeyboardEvent<HTMLHRElement>) => void
  readonly onLostPointerCapture: (event: PointerEvent<HTMLHRElement>) => void
  readonly onPointerCancel: (event: PointerEvent<HTMLHRElement>) => void
  readonly onPointerDown: (event: PointerEvent<HTMLHRElement>) => void
  readonly onPointerEnter: () => void
  readonly onPointerLeave: () => void
  readonly onPointerMove: (event: PointerEvent<HTMLHRElement>) => void
  readonly onPointerUp: (event: PointerEvent<HTMLHRElement>) => void
}

/**
 * 侧边栏分隔条的拖拽会话。
 *
 * 指针捕获交给平台：一次 setPointerCapture 之后，move / up / cancel 都会派发到
 * 分隔条本身，即使指针越过主区或离开窗口，所以不需要 document 上的全局监听。
 *
 * 交互态是 workspaceLayoutStore.splitter，本 hook 是它唯一的写入方：hover 由指针
 * 进出改写，drag 由按下改写，收尾按几何回到 hover 或 idle，卸载一律收回 idle。
 */
export function useSidebarResize({
  width,
  min,
  max,
  onResize,
  onCollapse,
}: SidebarResizeOptions): SidebarResizeBindings {
  const sessionRef = useRef<SidebarDragSession | null>(null)

  const clamp = (next: number): number => Math.max(min, Math.min(max, Math.round(next)))

  const settle = (session: SidebarDragSession, finalWidth: number): void => {
    sessionRef.current = null

    /* lostpointercapture 时捕获已释放，此时 release 会抛 NotFoundError。 */
    if (session.element.hasPointerCapture(session.pointerId)) {
      session.element.releasePointerCapture(session.pointerId)
    }

    onResize(finalWidth)
    workspaceLayoutStore.setSplitterActivity(
      isPointerOver(session.element, session.point) ? 'hover' : 'idle',
    )
  }

  const handlePointerDown = (event: PointerEvent<HTMLHRElement>): void => {
    if (event.button !== 0 || sessionRef.current !== null) {
      return
    }

    event.preventDefault()
    event.stopPropagation()

    const element = event.currentTarget

    sessionRef.current = {
      pointerId: event.pointerId,
      element,
      startX: event.clientX,
      startWidth: width,
      point: { x: event.clientX, y: event.clientY },
    }

    workspaceLayoutStore.setSplitterActivity('drag')
    element.setPointerCapture(event.pointerId)

    /* 取得焦点后，拖拽中的 Esc 与拖拽后的方向键微调才能落到分隔条上。 */
    element.focus()
  }

  const handlePointerMove = (event: PointerEvent<HTMLHRElement>): void => {
    const session = sessionRef.current

    if (session?.pointerId !== event.pointerId) {
      return
    }

    session.point = { x: event.clientX, y: event.clientY }

    onResize(clamp(session.startWidth + event.clientX - session.startX))
  }

  const handlePointerEnd = (event: PointerEvent<HTMLHRElement>): void => {
    const session = sessionRef.current

    if (session?.pointerId !== event.pointerId) {
      return
    }

    settle(session, clamp(session.startWidth + event.clientX - session.startX))
  }

  /* 悬停只在没有会话时由指针进出改写；拖拽中的进出由 settle 统一收尾。 */
  const handlePointerEnter = (): void => {
    if (sessionRef.current === null) {
      workspaceLayoutStore.setSplitterActivity('hover')
    }
  }

  const handlePointerLeave = (): void => {
    if (sessionRef.current === null) {
      workspaceLayoutStore.setSplitterActivity('idle')
    }
  }

  /* 条随侧栏收起而卸载：谁写的状态谁收回，否则再展开时线是粗的。 */
  useEffect(
    () => () => {
      workspaceLayoutStore.setSplitterActivity('idle')
    },
    [],
  )

  const handleKeyDown = (event: KeyboardEvent<HTMLHRElement>): void => {
    const session = sessionRef.current

    /* 拖拽中按 Esc 放弃本次调整并回到起始宽度，与通用拖拽语义一致。 */
    if (event.key === 'Escape') {
      if (session !== null) {
        event.preventDefault()
        settle(session, session.startWidth)
      }

      return
    }

    const step = event.shiftKey ? 64 : 16

    switch (event.key) {
      case 'ArrowLeft':
        event.preventDefault()
        onResize(clamp(width - step))
        break

      case 'ArrowRight':
        event.preventDefault()
        onResize(clamp(width + step))
        break

      case 'Home':
        event.preventDefault()
        onResize(min)
        break

      case 'End':
        event.preventDefault()
        onResize(max)
        break
    }
  }

  const handleDoubleClick = (event: MouseEvent<HTMLHRElement>): void => {
    event.preventDefault()
    event.stopPropagation()

    onCollapse()
  }

  return {
    onDoubleClick: handleDoubleClick,
    onKeyDown: handleKeyDown,
    onLostPointerCapture: handlePointerEnd,
    onPointerCancel: handlePointerEnd,
    onPointerDown: handlePointerDown,
    onPointerEnter: handlePointerEnter,
    onPointerLeave: handlePointerLeave,
    onPointerMove: handlePointerMove,
    onPointerUp: handlePointerEnd,
  }
}
