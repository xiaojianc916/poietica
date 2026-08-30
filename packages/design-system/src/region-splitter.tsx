import { type KeyboardEvent, type PointerEvent, useEffect, useRef } from 'react'

/** 分隔条的交互态。写入方只有本文件的指针处理器。 */
export type SplitterActivity = 'idle' | 'hover' | 'drag'

/** 被调整的区域贴窗口哪一侧。决定指针位移到宽度的符号。 */
export type RegionEdge = 'inline-start' | 'inline-end'

export interface RegionSplitterProps {
  readonly label: string
  readonly edge: RegionEdge
  readonly width: number
  readonly min: number
  readonly max: number
  readonly onResize: (width: number) => void
  readonly onCollapse: () => void
  /** 必须是稳定引用：卸载时要用它收回交互态。 */
  readonly onActivity: (activity: SplitterActivity) => void
}

interface DragSession {
  readonly pointerId: number
  readonly element: HTMLHRElement
  readonly startX: number
  readonly startWidth: number
  /* 最后已知的指针位置：收尾时用它判定指针是否还在条上。 */
  point: { readonly x: number; readonly y: number }
}

/*
 * 指针是否还在条上，按几何自己算。捕获期间 :hover 按 Pointer Events L3 被记在
 * 捕获元素上，所以收尾态不能问浏览器。
 */
function isPointerOver(element: HTMLHRElement, point: { x: number; y: number }): boolean {
  const rect = element.getBoundingClientRect()

  return (
    point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom
  )
}

/**
 * 区域分隔条。
 *
 * 元素用 hr：隐式 ARIA 角色就是 separator，可聚焦时按规范可携带 aria-valuenow。
 * 指针捕获交给平台：setPointerCapture 之后 move / up / cancel 都派发到条本身，
 * 越过邻区或离开窗口也不丢，因此不需要 document 上的全局监听。
 * 交互态经 onActivity 交回调用方 —— 条不认识任何 store。
 */
export function RegionSplitter({
  label,
  edge,
  width,
  min,
  max,
  onResize,
  onCollapse,
  onActivity,
}: RegionSplitterProps) {
  const session = useRef<DragSession | null>(null)

  /* 贴 inline-start 的区域向右拖变宽，贴 inline-end 的向左拖变宽。 */
  const grow = edge === 'inline-start' ? 1 : -1

  const clamp = (next: number): number => Math.max(min, Math.min(max, Math.round(next)))

  const widthAt = (current: DragSession, clientX: number): number =>
    clamp(current.startWidth + grow * (clientX - current.startX))

  const settle = (current: DragSession, finalWidth: number): void => {
    session.current = null

    /* lostpointercapture 时捕获已释放，此时 release 会抛 NotFoundError。 */
    if (current.element.hasPointerCapture(current.pointerId)) {
      current.element.releasePointerCapture(current.pointerId)
    }

    onResize(finalWidth)
    onActivity(isPointerOver(current.element, current.point) ? 'hover' : 'idle')
  }

  const end = (event: PointerEvent<HTMLHRElement>): void => {
    const current = session.current

    if (current?.pointerId !== event.pointerId) {
      return
    }

    settle(current, widthAt(current, event.clientX))
  }

  /* 条随区域收起而卸载：谁写的状态谁收回。 */
  useEffect(
    () => () => {
      onActivity('idle')
    },
    [onActivity],
  )

  const keyDown = (event: KeyboardEvent<HTMLHRElement>): void => {
    const current = session.current

    /* 拖拽中 Esc 放弃本次调整并回到起始宽度，与通用拖拽语义一致。 */
    if (event.key === 'Escape') {
      if (current !== null) {
        event.preventDefault()
        settle(current, current.startWidth)
      }

      return
    }

    const step = (event.shiftKey ? 64 : 16) * grow

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

  return (
    <hr
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemax={max}
      aria-valuemin={min}
      aria-valuenow={Math.round(width)}
      className={
        'workspace-region-splitter absolute top-0 z-40 h-full w-2 cursor-col-resize touch-none ' +
        'select-none border-0 bg-transparent outline-none ' +
        (edge === 'inline-start' ? '-right-1' : '-left-1')
      }
      data-edge={edge}
      onDoubleClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        onCollapse()
      }}
      onKeyDown={keyDown}
      onLostPointerCapture={end}
      onPointerCancel={end}
      onPointerDown={(event) => {
        if (event.button !== 0 || session.current !== null) {
          return
        }

        event.preventDefault()
        event.stopPropagation()

        const element = event.currentTarget

        session.current = {
          pointerId: event.pointerId,
          element,
          startX: event.clientX,
          startWidth: width,
          point: { x: event.clientX, y: event.clientY },
        }

        onActivity('drag')
        element.setPointerCapture(event.pointerId)

        /* 取得焦点后，拖拽中的 Esc 与拖拽后的方向键微调才能落到条上。 */
        element.focus()
      }}
      onPointerEnter={() => {
        if (session.current === null) {
          onActivity('hover')
        }
      }}
      onPointerLeave={() => {
        if (session.current === null) {
          onActivity('idle')
        }
      }}
      onPointerMove={(event) => {
        const current = session.current

        if (current?.pointerId !== event.pointerId) {
          return
        }

        current.point = { x: event.clientX, y: event.clientY }
        onResize(widthAt(current, event.clientX))
      }}
      onPointerUp={end}
      tabIndex={0}
    />
  )
}
