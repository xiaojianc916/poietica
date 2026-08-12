import { useCallback } from 'react'
import { railCentre } from './rail-groups'

const TURN = '.conversation-minimap__turn'
const CARD = '.conversation-minimap__card'
const SHOWN = 'data-shown'

/**
 * 一张卡片,在轨道上滑动。
 *
 * 原先是一格一张卡片。换格时旧的立刻开始淡出、新的等 90ms 才淡入,而两张卡片
 * 的锚点只差 13px、卡片本身高四五十像素 —— 于是中间那一百多毫秒里两张半透明
 * 的卡片几乎完全重叠。看上去不是"切换",是穿模。而且那 90ms 每跨一格重计一次,
 * 扫过二十格就是二十轮淡出淡入。把过渡调长只会让重叠期更长。
 *
 * 所以换成共享元素:整条轨道只有一张卡片,换格时它沿轨道滑过去,文字同时换掉。
 * 两张卡片永远不会共存,穿模无从发生。延迟只在"从无到有"时计一次 —— 已经显示
 * 着的时候换格是零延迟的纯位移,这正是 Radix 的 skipDelayDuration 在做的事。
 *
 * 指针状态不进 React。use-fisheye 里那句注释同样适用:指针扫过轨道会把整条
 * 记录重渲染一遍。这里只在跨格时动一下 DOM,不惊动 React。
 */
export function useRailCard(): (node: HTMLElement | null) => (() => void) | undefined {
  return useCallback((node: HTMLElement | null) => {
    if (node === null) {
      return undefined
    }

    const view = node.ownerDocument.defaultView

    if (view === null) {
      return undefined
    }

    /* 两个时长仍然留在样式表里 —— 它们是观感参数,不是逻辑。挂载时读一次。 */
    const ms = (name: string, fallback: number): number => {
      const value = Number.parseFloat(view.getComputedStyle(node).getPropertyValue(name))

      return Number.isFinite(value) ? value : fallback
    }

    const enterMs = ms('--cp-rail-card-delay', 90)
    const leaveMs = ms('--cp-rail-card-leave', 60)

    let enterTimer = 0
    let leaveTimer = 0
    let current: HTMLElement | null = null

    /*
     * 一帧结算一次。
     *
     * 此前 settle 是 MutationObserver 的回调本身，而写 data-aimed 的是鱼眼在
     * requestAnimationFrame 里干的活 —— 观察者回调跑在紧随其后的微任务里，于是
     * 每一帧都是「rAF 写柱子长度 → 微任务读 offsetTop」，读的正是刚被写脏的那套
     * 几何。两个文件各自看都干净，循环是在它们之间闭合的。
     *
     * 收进帧之后，读和写落在同一帧里，而且无论平台派发多少次事件都只结算一次。
     * 这与 use-fisheye 是同一个范式，不是第二套。
     */
    let frame = 0

    /*
     * 指针和焦点自己记，不再问选择器。
     *
     * ':hover' 与 ':focus-visible' 用 querySelector 去匹配，要求浏览器先把当前的
     * hover 链与焦点态解析出来 —— 每问一次强制一次样式重算，而这两句此前每帧至少
     * 跑一遍。事件里 closest() 拿到的是同一个答案，代价是一次祖先遍历。
     */
    let hovered: HTMLElement | null = null
    let focused: HTMLElement | null = null

    /*
     * 卡片的四个槽位。
     *
     * 整条轨道只有一张卡片，它那三层文字是 React 渲染的固定结构，在卡片活着的
     * 期间不会变。isConnected 兜住 React 把它整个换掉的那一次。
     */
    type Slots = {
      readonly box: HTMLElement
      readonly kicker: HTMLElement | null
      readonly question: HTMLElement | null
      readonly reply: HTMLElement | null
    }

    let slots: Slots | null = null

    const slotsOf = (): Slots | null => {
      if (slots?.box.isConnected) {
        return slots
      }

      /*
       * :scope > —— 卡片是 nav 的直接子节点。此前这里是裸的 querySelector(CARD)，
       * 而那时每个按钮里也各有一张同类名的卡片，于是文档序第一个匹配是第 1 格
       * 里的那张：这套逻辑从头到尾在操作错误的元素，而 --cp-rail-card-y 又是按
       * nav 坐标算的，定位基准跟着错开一整格。按钮里的卡片已经删掉，这条限定是
       * 为了让「唯一那张」在选择器层面就说得死。
       */
      const box = node.querySelector<HTMLElement>(`:scope > ${CARD}`)

      if (box === null) {
        slots = null

        return null
      }

      slots = {
        box,
        kicker: box.querySelector<HTMLElement>('.conversation-minimap__card-kicker'),
        question: box.querySelector<HTMLElement>('.conversation-minimap__card-question'),
        reply: box.querySelector<HTMLElement>('.conversation-minimap__card-reply'),
      }

      return slots
    }

    /*
     * 三个来源,一个答案。
     *
     * 键盘焦点压过指针:人按了 Tab 就是在用键盘,这时候鼠标停在哪里是历史遗留。
     * data-aimed 压过 :hover,因为鱼眼的判定范围朝内容侧探出 28px —— 指针还没压到
     * 轨道上,预览就该出来了,这是原来的行为,不能因为换了实现就丢掉。
     * :hover 兜底:粗指针和减弱动效两种情况下鱼眼直接提前返回,不写 data-aimed。
     */
    const targetOf = (): HTMLElement | null =>
      focused ?? node.querySelector<HTMLElement>(`${TURN}[data-aimed]`) ?? hovered

    /*
     * 第几格 —— 数前面的兄弟,不问布局。
     *
     * 卡片也是 nav 的直接子节点,所以按类名数而不是按位置数。matches 走的是选择器
     * 匹配,与这份文件上面提到的 ':hover' / ':focus-visible' 不同,不需要先把样式
     * 解析出来。格数由 RAIL_MAX_BARS 封顶,这一趟至多三十来步。
     */
    const slotOf = (cell: HTMLElement): number => {
      let index = 0

      for (let at = cell.previousElementSibling; at !== null; at = at.previousElementSibling) {
        if (at.matches(TURN)) {
          index += 1
        }
      }

      return index
    }

    const fill = ({ box, kicker, question, reply }: Slots, turn: HTMLElement): void => {
      const kickerText = turn.getAttribute('data-card-kicker')
      const replyText = turn.getAttribute('data-card-reply')

      if (kicker !== null) {
        kicker.textContent = kickerText ?? ''
        kicker.hidden = kickerText === null
      }

      if (question !== null) {
        question.textContent = turn.getAttribute('data-card-label') ?? ''
      }

      if (reply !== null) {
        reply.textContent = replyText ?? ''
        reply.hidden = replyText === null
      }

      /*
       * 定位到这一格的中线,而这个数是算出来的。
       *
       * 此前是 turn.offsetTop + turn.offsetHeight / 2。这套布局里两个读数都是常量
       * (格高恒为 --cp-rail-hit、flex-shrink: 0、轨道无内边距、格间无间距),所以它
       * 恒等于 railCentre(第几格)。区别只在 offsetTop 会强制 flush 一遍布局 —— 而
       * 这一帧的布局刚被鱼眼写脏:它按权重改每根横条的 inline-size。
       *
       * use-fisheye 里那段「算出来的,不是量出来的」正是为这件事写的,当时只改了它
       * 自己;剩下的这一条就是它说的第二条管线。
       */
      box.style.setProperty('--cp-rail-card-y', `${String(railCentre(slotOf(turn)))}px`)
    }

    const settle = (): void => {
      const found = slotsOf()

      if (found === null) {
        return
      }

      const { box } = found
      const turn = targetOf()

      if (turn === null) {
        view.clearTimeout(enterTimer)
        enterTimer = 0

        if (current === null) {
          return
        }

        current = null

        /*
         * 宽限期。擦着边缘划过去、或者从一格到另一格中间掠过一片空白,不该让
         * 卡片闪一下。这段时间里 data-shown 还在,所以真回来了就只是接着滑。
         */
        leaveTimer = view.setTimeout(() => {
          leaveTimer = 0
          box.removeAttribute(SHOWN)
        }, leaveMs)

        return
      }

      if (turn === current) {
        return
      }

      view.clearTimeout(leaveTimer)
      leaveTimer = 0
      current = turn
      fill(found, turn)

      /*
       * 已经显示着就到此为止:位置刚写完,CSS 会把它滑过去,零延迟、不淡出。
       *
       * 还没显示才计时,而且只计一次 —— 延迟是"你确实想看"的门槛,不是每格
       * 都要重新翻越一遍的栏杆。这段时间里位置照写,只是看不见,所以门槛过了
       * 之后卡片是直接在正确的地方淡出来,不会从上一格飘过来。
       */
      if (box.hasAttribute(SHOWN) || enterTimer !== 0) {
        return
      }

      enterTimer = view.setTimeout(() => {
        enterTimer = 0
        box.setAttribute(SHOWN, '')
      }, enterMs)
    }

    const paint = (): void => {
      frame = 0
      settle()
    }

    const schedule = (): void => {
      if (frame === 0) {
        frame = view.requestAnimationFrame(paint)
      }
    }

    /*
     * pointerover 是冒泡的：指针每跨过一根柱子的边界就派发一次，扫过二十格就是
     * 二十次。此前这二十次每次都跑完整个 settle，而跨格判断在那两次昂贵查询的
     * 后面 —— 便宜的判断被排在贵的操作之后，等于没有判断。现在它只记一个元素。
     */
    const onPointerOver = (event: PointerEvent): void => {
      hovered = (event.target as Element | null)?.closest<HTMLElement>(TURN) ?? null
      schedule()
    }

    const onPointerLeave = (): void => {
      hovered = null
      schedule()
    }

    /* 键盘压过指针的语义不变；':focus-visible' 只在真的换焦点时问一次。 */
    const onFocusIn = (event: FocusEvent): void => {
      const turn = (event.target as Element | null)?.closest<HTMLElement>(TURN) ?? null

      focused = turn?.matches(':focus-visible') ? turn : null
      schedule()
    }

    const onFocusOut = (): void => {
      focused = null
      schedule()
    }

    /*
     * 两个观察者,不是一个。
     *
     * 同一个 MutationObserver 对同一个节点再 observe 一次是替换而不是叠加,而
     * 这两件事要的范围正好相反:格子的增删只发生在 nav 的直接子节点上,不要
     * subtree;data-aimed 挂在格子上,要 subtree。合成一个就得开 subtree 的
     * childList,而 fill() 写 textContent 恰恰就是 subtree 的 childList 变更 ——
     * 那是一个自己喂自己的循环。
     */
    const structure = new view.MutationObserver(schedule)
    const aim = new view.MutationObserver(schedule)

    structure.observe(node, { childList: true })
    aim.observe(node, { attributeFilter: ['data-aimed'], subtree: true })

    node.addEventListener('pointerover', onPointerOver, { passive: true })
    node.addEventListener('pointerleave', onPointerLeave, { passive: true })
    node.addEventListener('focusin', onFocusIn)
    node.addEventListener('focusout', onFocusOut)

    return () => {
      if (frame !== 0) {
        view.cancelAnimationFrame(frame)
      }

      view.clearTimeout(enterTimer)
      view.clearTimeout(leaveTimer)
      structure.disconnect()
      aim.disconnect()
      node.removeEventListener('pointerover', onPointerOver)
      node.removeEventListener('pointerleave', onPointerLeave)
      node.removeEventListener('focusin', onFocusIn)
      node.removeEventListener('focusout', onFocusOut)
    }
  }, [])
}
