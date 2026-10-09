import { type KeyboardEvent, type PointerEvent, useEffect, useRef } from 'react'

/** 分隔条的交互态。写入方只有本文件的指针处理器。 */
export type SplitterActivity = 'idle' | 'hover' | 'drag'

/**
 * 被调整的区域贴窗口哪一侧。决定指针位移到尺寸的符号。
 *
 * inline-* 是竖条（左右分栏，拖 X），block-* 是横条（上下分栏，拖 Y）。
 * 底部面板坞用 block-start：条在面板上缘，往上拖面板变高。
 */
export type RegionEdge = 'inline-start' | 'inline-end' | 'block-start' | 'block-end'

const isBlockEdge = (edge: RegionEdge): boolean => edge === 'block-start' || edge === 'block-end'

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
  readonly startY: number
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

  return point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom
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
  /* 排期中那一帧的宽度上报（见 onPointerMove）。 */
  const pending = useRef<number | null>(null)

  /*
   * 尺寸随指针位移的符号：贴 inline-start 的区域向右拖变宽，贴 inline-end 的向左拖变宽；
   * 贴 block-start 的区域（底坞）向上拖变高，贴 block-end 的向下拖变高。
   */
  const grow = edge === 'inline-start' ? 1 : edge === 'inline-end' ? -1 : edge === 'block-start' ? -1 : 1
  /* 位移取的是哪一轴：横条读 clientY，竖条读 clientX。 */
  const axis = isBlockEdge(edge) ? 'block' : 'inline'

  const clamp = (next: number): number => Math.max(min, Math.min(max, Math.round(next)))

  const widthAt = (current: DragSession, delta: number): number => clamp(current.startWidth + grow * delta)
  /* 指针这一位置对应的位移：竖条取 X、横条取 Y，起点在会话里同轴记着。 */
  const deltaAt = (current: DragSession, point: { readonly x: number; readonly y: number }): number =>
    axis === 'block' ? point.y - current.startY : point.x - current.startX

  /*
   * 收尾只有一个出口：放捕获、把最终宽度交回、把交互态归位。
   *
   * 交互态由调用方点名，不在这里按几何猜：指针离开文档那一路（下面那条监听）几何
   * 已经不可信 —— 最后已知的位置还留在条上，而指针其实已经进了原生子 webview。
   */
  const settle = (current: DragSession, finalWidth: number, activity: SplitterActivity): void => {
    session.current = null

    /* 松手时排期中的那一帧作废：它读的是已经交出去的会话，落地会把最终宽度又改回去。 */
    if (pending.current !== null) {
      cancelAnimationFrame(pending.current)
      pending.current = null
    }

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

    settle(current, widthAt(current, deltaAt(current, { x: event.clientX, y: event.clientY })), restActivity(current))
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

    settle(current, widthAt(current, deltaAt(current, current.point)), 'idle')
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
      if (pending.current !== null) {
        cancelAnimationFrame(pending.current)
      }

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

    /*
     * 键盘步进：竖条左右键调宽，横条上下键调高。两个方向键按语义分派（右 / 上 = 变大），
     * 步进与 grow 无关 —— grow 只管指针位移，键盘这条路径不经过它。
     */
    const step = event.shiftKey ? 64 : 16
    const forwardKey = axis === 'block' ? 'ArrowUp' : 'ArrowRight'
    const backwardKey = axis === 'block' ? 'ArrowDown' : 'ArrowLeft'

    switch (event.key) {
      case forwardKey:
        event.preventDefault()
        onResize(clamp(width + step))
        break

      case backwardKey:
        event.preventDefault()
        onResize(clamp(width - step))
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
      aria-orientation={axis === 'block' ? 'horizontal' : 'vertical'}
      aria-valuemax={max}
      aria-valuemin={min}
      aria-valuenow={Math.round(width)}
      className={
        'workspace-region-splitter absolute z-[var(--ui-z-floating)] ' +
        'touch-none select-none border-0 bg-transparent outline-none ' +
        /* 命中区是分隔线的 8 倍宽，跨在线的两侧各一半：线宽改一处，命中区跟着走。 */
        (isBlockEdge(edge)
          ? 'cursor-row-resize left-0 right-0 [block-size:calc(var(--ui-region-divider-width)*8)] ' +
            (edge === 'block-start' ? 'top-0 -translate-y-1/2' : 'bottom-0 translate-y-1/2')
          : 'cursor-col-resize top-0 h-full [inline-size:calc(var(--ui-region-divider-width)*8)] ' +
            (edge === 'inline-start' ? 'right-0 translate-x-1/2' : 'left-0 -translate-x-1/2'))
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

        /*
         * 先拿捕获，再登记会话。
         *
         * 反过来的话，`setPointerCapture` 一抛（指针已经不在了 —— 这个调用按规范会抛
         * NotFoundError）就会把 `session.current` 留在一个非空的值上，而上面那道
         * `session.current !== null` 闸门从此永远为真：这条分隔线**再也拖不动**。
         * 一次平台调用失败不该让面板宽度永久锁死。
         */
        try {
          element.setPointerCapture(event.pointerId)
        } catch {
          /* 拿不到捕获就不开始这次拖拽：按一下没反应，好过之后再也按不动。 */
          return
        }

        session.current = {
          pointerId: event.pointerId,
          element,
          startX: event.clientX,
          startY: event.clientY,
          startWidth: width,
          point: { x: event.clientX, y: event.clientY },
        }

        onActivity('drag')
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

        /*
         * 最后已知位置立刻记下（收尾判定要用），宽度**合到帧上**再报。
         *
         * 高轮询鼠标一帧能发好几次 pointermove，而每一次 onResize 都会把整个外壳重渲一遍
         * （宽度住在布局 store 里，主区也要跟着重排）。合并到帧上不改变结果 —— 同一帧里
         * 最后那一次本来就会盖掉前面几次 —— 只把重复的那几趟省掉。第一次移动不等帧：
         * 拖动的第一下必须立刻跟手。
         */
        current.point = { x: event.clientX, y: event.clientY }

        if (pending.current !== null) {
          return
        }

        pending.current = requestAnimationFrame(() => {
          pending.current = null

          const active = session.current

          if (active !== null) {
            onResize(widthAt(active, deltaAt(active, active.point)))
          }
        })
      }}
      onPointerUp={end}
      tabIndex={0}
    />
  )
}
