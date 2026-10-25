import { Component, type ReactNode, type RefObject } from 'react'

/*
 * 键控行的位移与进出场 —— 正本是 DeepSeek Harness 的
 * packages/client/ui-primitives/src/AnimatedRows.tsx
 * （https://github.com/deepseek-ai/deepseek-harness）：ROW_FADE_MS 100、ROW_GLIDE_MS 200、ease-out。
 *
 * 为什么是 FLIP 而不是给每行挂 CSS transition：插入一行会同时改写它下面所有行的位置，而 transition 只在
 * 属性值变化时启动 —— 新行自己也没有「上一帧」。这里在提交前后各量一次：仍活着的行按位移差先摆回原位再
 * 走回去，新行只淡入，被删的行留一张影子淡出。
 *
 * 为什么不引 motion 库：这一层与提交顺序绑死（提交前量旧位置、提交后量新位置），motion 的 layout 动画走
 * 的是另一套订阅；Web Animations 的 element.animate 在这里够用，且动画收尾即 cancel，不留状态。
 *
 * 一行 = 一个带 data-row-key 的元素，彼此不得互为祖先。容器不挂键：给容器补间，盒里的行会被算两遍位移。
 *
 * 与正本的出入，都是本仓的形态逼出来的：
 * - 滚动盒由调用方持有（它同时挂着该皮肤的令牌与列表语义），这里只做行为、不渲染盒子。
 * - 退场影子回到被删那行原来的父元素里，坐标相对滚动盒算。本仓每一组各自套着一层 overflow: hidden 的
 *   展开壳，影子若收进全列共用的浮层里就会被那层壳裁掉。
 * - 正本在影子上抄一份 padding（它的行缩进是内联变量）；这里的行缩进读继承来的 --ui-row-*，影子留在原父
 *   元素里照样继承，不抄。
 * - 正本假定静止不透明度恒为 1；这里有静音的会话行（0.45），收尾那一帧读行自己的计算值。
 */

const ROW_FADE_MS = 100
const ROW_GLIDE_MS = 200
/** 放开裁剪的时点：滑行与淡出都走完之后，留一帧余量。 */
const CLIP_RELEASE_MS = ROW_GLIDE_MS + ROW_FADE_MS

export interface AnimatedRowsProps {
  /** 持有滚动的那一层，必须是定位祖先（退场影子按它算坐标）。视口几何也读它。 */
  readonly scroller: RefObject<HTMLElement | null>
  /** 按 DOM 顺序列出的键，与渲染出来的 data-row-key 一一对应。顺序没变就一个矩形都不量。 */
  readonly rowKeys: readonly string[]
  /** 读取落定之前不补间：首屏那一批不该一行一行地淡进来。 */
  readonly ready: boolean
  /** 换成另一份视图（搜索、分组、展开更多、收起组）时立即落定：整块重排的补间只会读成抖动。 */
  readonly resetKey: string
}

interface RowPosition {
  readonly element: HTMLElement
  readonly rect: DOMRect
  /** 补间途中读到的不透明度；静止时为 null，收尾按样式里的值走。 */
  readonly opacity: number | null
  /** 影子要回到这一格。快照里存原父元素：克隆体自己不在文档里，问不出它的父元素。 */
  readonly host: HTMLElement | null
}

interface RowSnapshot {
  readonly positions: ReadonlyMap<string, RowPosition>
  readonly removed: ReadonlyMap<string, RowPosition>
}

export class AnimatedRows extends Component<AnimatedRowsProps> {
  private readonly movements = new Map<HTMLElement, Animation>()
  private readonly exits = new Map<string, { readonly element: HTMLElement; readonly animation: Animation }>()
  private clipTimer: number | null = null

  /** 键序列一模一样 = 这一帧没换成员也没换顺序。时钟每跳一次都会重渲这一列，这一条挡住那一路的测量。 */
  private rowsUnchanged(previous: AnimatedRowsProps): boolean {
    return (
      previous.rowKeys.length === this.props.rowKeys.length &&
      previous.rowKeys.every((key, index) => key === this.props.rowKeys[index])
    )
  }

  override getSnapshotBeforeUpdate(previous: AnimatedRowsProps): RowSnapshot | null {
    const scroller = this.props.scroller.current
    if (scroller === null || !previous.ready || !this.props.ready) return null
    if (previous.resetKey !== this.props.resetKey || this.rowsUnchanged(previous)) return null
    if (typeof scroller.animate !== 'function') return null
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return null

    const viewport = scroller.getBoundingClientRect()
    const positions = this.readPositions()
    const nextKeys = new Set(this.props.rowKeys)
    const removed = new Map<string, RowPosition>()
    for (const [key, row] of positions) {
      /* 不留影子的两种：这一键还在（它只是挪了位置），或者它在滚动视口外（淡出看不见）。 */
      if (nextKeys.has(key)) continue
      if (row.rect.bottom <= viewport.top || row.rect.top >= viewport.bottom) continue
      /* 必须现在就克隆：这一帧提交之后原元素已经不在 DOM 里，没有东西可以被 animate 到淡出。 */
      const clone = row.element.cloneNode(true) as HTMLElement
      clone.removeAttribute('data-row-key')
      clone.inert = true
      /* host 随 row 一起进快照 —— 克隆体不在文档里，之后问不出父元素。 */
      removed.set(key, { ...row, element: clone })
    }
    return { positions, removed }
  }

  override componentDidUpdate(previous: AnimatedRowsProps, _state: unknown, snapshot: RowSnapshot | null): void {
    if (snapshot === null) {
      /* 只有真换了成员、换了视图或换了 ready 才清：无条件清会让时钟每跳一次都把滑到一半的行掐断。 */
      if (
        previous.resetKey !== this.props.resetKey ||
        previous.ready !== this.props.ready ||
        !this.rowsUnchanged(previous)
      ) {
        this.clear()
      }
      return
    }

    this.cancelMovements()
    const positions = this.readPositions()
    this.glide(positions, snapshot.positions)
    for (const [key, row] of snapshot.removed) {
      /* 同一键仍在 DOM 里（rowKeys 与渲染不同步）就不留影子：叠一份会读成重影。 */
      if (!positions.has(key)) this.park(key, row)
    }
  }

  override componentWillUnmount(): void {
    this.clear()
  }

  /** 仍活着的行：新行淡入，挪了位置的行从旧位置滑回新位置。 */
  private glide(next: ReadonlyMap<string, RowPosition>, previous: ReadonlyMap<string, RowPosition>): void {
    for (const [key, row] of next) {
      /* 这一键又回来了：先前那张影子作废，否则同一行会凭空消失一次。 */
      this.removeExit(key)
      const before = previous.get(key)
      /* 行自己可能就带着透明度（静音的会话是 0.45），收尾要落回它而不是写死 1。
       * 读不到（样式还没挂上、量在若环境里）时按 1 —— Number('') 是 0，会把淡入变成不显示。 */
      const parsed = Number.parseFloat(getComputedStyle(row.element).opacity)
      const resting = Number.isNaN(parsed) ? 1 : parsed

      if (before === undefined) {
        this.animate(row.element, [{ opacity: 0 }, { opacity: resting }], ROW_FADE_MS)
        continue
      }

      const dx = before.rect.left - row.rect.left
      const dy = before.rect.top - row.rect.top
      if (dx === 0 && dy === 0 && before.opacity === null) continue

      this.animate(
        row.element,
        [
          { transform: `translate(${String(dx)}px, ${String(dy)}px)`, opacity: before.opacity ?? resting },
          { transform: 'translate(0, 0)', opacity: resting },
        ],
        ROW_GLIDE_MS,
      )
    }
  }

  /** 把退场影子摆回它离开时那一格，再淡出。 */
  private park(key: string, row: RowPosition): void {
    const host = row.host
    const scroller = this.props.scroller.current
    if (host === null || scroller === null) return

    /* 影子的包含块是滚动盒（它 position: relative），所以坐标按滚动盒算、并把已滚掉的量补回去。 */
    const origin = scroller.getBoundingClientRect()
    const element = row.element
    Object.assign(element.style, {
      position: 'absolute',
      margin: '0',
      transform: 'none',
      boxSizing: 'border-box',
      left: `${String(row.rect.left - origin.left + scroller.scrollLeft)}px`,
      top: `${String(row.rect.top - origin.top + scroller.scrollTop)}px`,
      width: `${String(row.rect.width)}px`,
      height: `${String(row.rect.height)}px`,
    })
    host.append(element)
    /* 影子也在组壳里：只有它一个要淡出（例如删掉组里最后一行）时没有滑行来打这个标记。 */
    this.holdClipOpen()
    const animation = element.animate([{ opacity: row.opacity ?? 1 }, { opacity: 0 }], {
      duration: ROW_FADE_MS,
      easing: 'ease-out',
      fill: 'forwards',
    })
    this.exits.set(key, { element, animation })
    animation.onfinish = () => {
      this.removeExit(key)
    }
  }

  private readPositions(): Map<string, RowPosition> {
    const scroller = this.props.scroller.current
    const rows = scroller === null ? [] : scroller.querySelectorAll<HTMLElement>('[data-row-key]')
    return new Map(
      Array.from(rows, (element) => [
        element.dataset.rowKey as string,
        {
          element,
          rect: element.getBoundingClientRect(),
          /* 补间途中接手的那一行从当前的半透明处继续，不然每次重渲染都闪回一次全不透明。 */
          opacity: this.movements.has(element) ? Number.parseFloat(getComputedStyle(element).opacity) || 1 : null,
          host: element.parentElement,
        },
      ]),
    )
  }

  private animate(element: HTMLElement, keyframes: Keyframe[], duration: number): void {
    const animation = element.animate(keyframes, { duration, easing: 'ease-out' })
    this.movements.set(element, animation)
    animation.onfinish = () => {
      this.movements.delete(element)
      animation.cancel()
    }
    this.holdClipOpen()
  }

  /*
   * 滑行与淡出期间放开组壳的裁剪：.thread-disclosure 平时 overflow: hidden（给展开/收起的高度补间用）。
   * 删掉一行时盒子的高度已经先缩到新值，下面几行要从旧位置滑回来 —— 不放开就被切在组的下沿，
   * 位移照做，只是看不见。计时从最后一次动画起算，滑行比淡出长，取两者之和再收。
   */
  private holdClipOpen(): void {
    this.props.scroller.current?.setAttribute('data-moving', 'true')
    if (this.clipTimer !== null) window.clearTimeout(this.clipTimer)
    this.clipTimer = window.setTimeout(() => {
      this.clipTimer = null
      this.props.scroller.current?.removeAttribute('data-moving')
    }, CLIP_RELEASE_MS)
  }

  private cancelMovements(): void {
    for (const animation of this.movements.values()) {
      animation.onfinish = null
      animation.cancel()
    }
    this.movements.clear()
  }

  private removeExit(key: string): void {
    const exit = this.exits.get(key)
    if (exit === undefined) return
    exit.animation.onfinish = null
    exit.animation.cancel()
    exit.element.remove()
    this.exits.delete(key)
  }

  private clear(): void {
    this.cancelMovements()
    for (const key of this.exits.keys()) this.removeExit(key)
    if (this.clipTimer !== null) {
      window.clearTimeout(this.clipTimer)
      this.clipTimer = null
    }
    this.props.scroller.current?.removeAttribute('data-moving')
  }

  /** 行为层：没有自己的盒子，几何全在调用方的滚动盒里。 */
  override render(): ReactNode {
    return null
  }
}
