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
 *
 * 焦点不抢：按下时平台自己把焦点落到条上（见 onPointerDown 的注释），Esc 与方向键
 * 微调因此照旧可用。
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

  /*
   * 收尾只有一个出口：放捕获、把最终宽度交回、把交互态归位。
   *
   * 交互态由调用方点名，不在这里按几何猜：指针离开文档那一路（下面那条监听）几何
   * 已经不可信 —— 最后已知的位置还留在条上，而指针其实已经进了原生子 webview。
   */
  const settle = (current: DragSession, finalWidth: number, activity: SplitterActivity): void => {
    session.current = null

    /* lostpointercapture 时捕获已释放，此时 release 会抛 NotFoundError。 */
    if (current.element.hasPointerCapture(current.pointerId)) {
      current.element.releasePointerCapture(current.pointerId)
    }

    onResize(finalWidth)
    onActivity(activity)
  }

  /* 拖拽结束的那一刻指针还在不在条上，只能按几何算：捕获期间的 hover 记在捕获元素上。 */
  const restActivity = (current: DragSession): SplitterActivity =>
    isPointerOver(current.element, current.point) ? 'hover' : 'idle'

  const end = (event: PointerEvent<HTMLHRElement>): void => {
    const current = session.current

    if (current?.pointerId !== event.pointerId) {
      return
    }

    settle(current, widthAt(current, event.clientX), restActivity(current))
  }

  /*
   * 指针一离开文档就收不回交互态了。
   *
   * 右栏装的是原生子 webview：它整幅盖在宿主 DOM 之上，指针一进去文档就再也收不到
   * 指针事件 —— 没有 pointerleave，悬停态会一直亮着；拖到一半进去，pointerup 也等
   * 不到。判据在文档上而不在条上，所以监听挂 document（use-rail-pointer 同一条做法）。
   *
   * 收尾逻辑用 ref 持有：它要读当前这一帧的 props，而监听只装一次。
   */
  const release = useRef<() => void>(() => undefined)

  release.current = (): void => {
    const current = session.current

    if (current === null) {
      onActivity('idle')

      return
    }

    settle(current, widthAt(current, current.point.x), 'idle')
  }

  useEffect(() => {
    const onLeave = (): void => release.current()

    document.addEventListener('pointerleave', onLeave, { passive: true })

    return () => {
      document.removeEventListener('pointerleave', onLeave)
    }
  }, [])

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
        settle(current, current.startWidth, restActivity(current))
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
        'workspace-region-splitter absolute top-0 z-[var(--ui-z-floating)] h-full ' +
        'cursor-col-resize touch-none select-none border-0 bg-transparent outline-none ' +
        /* 命中区是分隔线的 8 倍宽，跨在线的两侧各一半：线宽改一处，命中区跟着走。 */
        '[inline-size:calc(var(--ui-region-divider-width)*8)] ' +
        (edge === 'inline-start' ? 'right-0 translate-x-1/2' : 'left-0 -translate-x-1/2')
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

        /*
         * 只拦冒泡，不 preventDefault、不 focus()：焦点与划选都交回平台。
         *
         * 脚本 focus() 会被 :focus-visible 启发式算成「键盘来的」——上一次交互是键盘时
         * 抓手就常亮到下一次点击（workspace-shell.css 的 :has 那条读的正是它）。平台按
         * 鼠标归类这次焦点，松手即灭；焦点照样落在条上，Esc 与方向键微调不受影响。
         */
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
