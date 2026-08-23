import './agent-activity-feed.css'

import type { Presentation } from '@poietica/agent'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useReducedMotion } from 'motion/react'
import { type ReactNode, useCallback, useLayoutEffect, useRef, useState } from 'react'
import { useFollowLatest } from '../primitives/follow-latest'
import { ChevronDownIcon } from '../primitives/icons'
import { startGlide } from '../primitives/scroll-glide'
import { useDevicePixels } from '../primitives/use-device-pixels'
import { type RowSpan, rowAtAnchor } from './reading-position'
import { useRevealIntent } from './use-reveal-intent'

/**
 * 视口之外预留的行数。
 *
 * 会话行远高于表格行,预留少了会在快速滚动时露白,多了则白白测量。
 */
const OVERSCAN_ROWS = 6

/**
 * 视线在视口里的位置,自上而下的比例。
 *
 * 高亮问的是"人在读哪一轮",而不是"哪一行碰到了视口上沿"。上沿是一条边,上一轮
 * 的残留一个像素就会占住它;三分之一处是人真正在看的地方,越界时机因此与阅读
 * 感知一致,而不与像素巧合一致。
 */
const READING_ANCHOR_RATIO = 1 / 3

/**
 * 顶行顶边离视口顶边不超过这么多像素,才算"贴齐"。
 *
 * 了结一次跳转要同时回答两问:顶行是不是目标行、它的顶边贴没贴齐。只看前一问,
 * 向上的位移会在进入目标行区间的那一刻被半路了结 —— 那正是"向上跳落点偏下"。
 * 0 太苛刻:落点吸附在设备像素上(snapToDevicePixels),缩放下与几何真值差最多
 * 半个物理像素;2 个 CSS 像素容得下这一点,又远小于任何一行的高度,不会把
 * "还在半路"误判成"到了"。
 */
const REVEAL_FLUSH_PX = 2

/**
 * 距顶端还有不到这么多屏，就去要更早的一页。
 *
 * 一屏的余量保证那一页在人真的滚到顶之前已经在路上，而不是触顶之后才开始等一次
 * IPC —— 触顶才取，看见的就是一次停顿。
 */
const EARLIER_LEAD_SCREENS = 1

/**
 * 会话流的滚动区。
 *
 * 这个组件只画会话态:一个滚动区,一枚回到末端的按钮,加一层不随滚动移动的浮层。
 *
 * 开场白与输入框由 AssistantSurface 持有,这个组件不知道它们存在。
 *
 * 滚动位置有两个写入者,而它们从不写同一件事:虚拟器补偿视口上方那些刚被测量的行,
 * follow-latest 拨末端。前者是唯一知道「哪一行的估高刚被真高替换」的,后者是唯一看得见
 * 真实末端的 —— 为什么末端不外包给虚拟器,整段理由写在 follow-latest 里。浏览器原生的
 * 滚动锚定是第三个写入者,它不知道前两个的存在,所以在样式里显式关闭。
 *
 * 本组件不做任何几何计算 —— 除了两个派生量,而它们共用一次读取:视线落在哪一行、视口
 * 顶端是哪一行。两者是同一次布局的两个侧面,一次布局只读一次几何,它们在时间上因此不会
 * 错开。「离末端多远」不在其中:那是 follow-latest 自己读的一次,而它读完只写 scrollTop,
 * 一个 state 都不碰。
 *
 * 这次读取挂在两处:滚动事件,以及尺寸变化。只挂滚动是不够的 —— 流式输出把行撑高、
 * 面板被拖窄、抽屉展开,都会让同一个滚动位置对应到另一行上,而它们都不产生滚动
 * 事件。通知走 ResizeObserver,不是「每一次布局之后重读一遍」:后者是拿一次强制回流,
 * 去换一个本来就有的通知。
 *
 * 它不认识条目类型:内容从渲染插槽进来,估高从估高插槽进来 —— 思考链与工具卡片的
 * 演化不触碰滚动。
 */

/**
 * 浮层可以向滚动区要什么。
 *
 * 行号,不是像素。浮层永远不该自己去量一行在哪。
 */
export interface FeedPort {
  /** 人正在读的那一行;跳转期间是人要求看的那一行。 */
  readonly activeRow: number
  readonly scrollToRow: (index: number) => void
}

export interface AgentActivityFeedProps {
  /**
   * 这些行属于哪一条对话。
   *
   * 滚动位置是这个盒子的状态，而这个盒子跨对话复用（上层不为它换 key）。「换了一条对话」
   * 与「同一条对话里又多了一句」是两件事，而转录内容分不出它们 —— 分不出的后果就是进一条
   * 旧对话时会看见一段本不该发生的位移。身份因此必须由持有它的那一层交下来，不从内容里猜。
   */
  readonly conversation: string
  readonly feed: Presentation
  /** 一行还没被测量时有多高。类别知识归转录那一侧，这里只用它给出的数。 */
  readonly estimateRow: (index: number) => number
  readonly renderRow: (index: number) => ReactNode
  readonly isBusy: boolean
  /** 上面还有没有更早的一页。 */
  readonly hasEarlier: boolean
  /** 顶端快见底了。读不读、读几页归转录那一侧。 */
  readonly onReachStart: () => Promise<void>
  /** 画在滚动区之上,位于一切会滚的东西之外。 */
  readonly overlay?: (port: FeedPort) => ReactNode
}

export function AgentActivityFeed({
  conversation,
  estimateRow,
  feed,
  hasEarlier,
  isBusy,
  onReachStart,
  overlay,
  renderRow,
}: AgentActivityFeedProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const transcriptRef = useRef<HTMLDivElement | null>(null)
  const tailRef = useRef<HTMLDivElement | null>(null)

  /*
   * 行的落点要踩在设备像素上。
   *
   * item.start 是 measureElement 测回的高度累加 —— 小数,而且同屏就有现成的
   * 小数源(.assistant-permission__ask 是 13px × 1.6 = 20.8px)。落在半个设备
   * 像素上,这一行里所有 1px 的边就被摊到两行、墨色减半:一张卡的外框因此在
   * 同一屏上时而是 1px #e0e0e0、时而是 2px #ececec。取整只动这一处 —— 位置
   * 只有一个写入点,所以对齐也只需要一个。
   */
  const snapToDevicePixels = useDevicePixels()

  /*
   * 转录相对滚动区的偏移:转录上面还有滚动区自己的上内边距,这段距离必须告诉
   * 虚拟器,否则它算出来的位置会整体上移那么多。
   *
   * 它是 state 而不是 ref:虚拟器在渲染期读它,而改 ref 不触发重渲染 —— 那样每一行的
   * 落点都会整体上移这段距离,直到别的什么事情恰好引起一次重渲染。
   *
   * 滚动区是转录的 offsetParent(样式里的 position: relative),所以这是一次
   * offsetTop,不需要两次 getBoundingClientRect 再减去 scrollTop。
   */
  const [scrollMargin, setScrollMargin] = useState(0)

  /*
   * 转录之后还有多少东西。
   *
   * scrollMargin 说的是转录之前，这个说的是转录之后，两者必须成对存在：滚动盒的
   * 末端等于 scrollMargin + getTotalSize() + 这一段，而虚拟器算末端时只用前两项。
   * 少声明一头，它的「底」就永远比真正的底高出这么多。跟随不再问它的底 ——
   * follow-latest 读的是 DOM 的底，那个数把这一段含在里面 —— 所以这个量现在只服务于
   * 区间与总高：少了它，最后几行会被尾部压住。
   *
   * 交给 paddingEnd 之后，这段空间进入虚拟器的坐标系，两个末端合成一个。数值是实
   * 测的而不是抄自令牌：尾部里装着等待指示器，高度本来就不是常量，而抄一份令牌就
   * 意味着 CSS 改了这里不会跟。
   */
  const [tailSize, setTailSize] = useState(0)

  /*
   * 视线落在哪一行。
   *
   * null 是"还没读到过",不是"第 0 行"。首帧的布局效应会把视口送到末尾,那一帧
   * 还没有任何几何可读,若此时谎称 0,缩略导航会先高亮第一轮再跳到最后一轮 ——
   * 开场那一下闪跳就是这么来的。
   */
  const [readingRow, setReadingRow] = useState<number | null>(null)

  const {
    pending,
    begin: beginReveal,
    settle: settleReveal,
    watch: watchReveal,
  } = useRevealIntent()

  /* 与 follow-latest 同一个来源：这个界面上「要不要少一些动效」只有一个答案。 */
  const reduced = useReducedMotion()

  /*
   * 末端由它拨,不由虚拟器拨。整段理由写在 follow-latest。
   *
   * 各有各的调用点:watch 装在滚动区上(与跳转闩锁同一处装卸),stick 在内容长高时报一次水位
   * 线,release 在人下跳转指令时让开,travel 在人亲手要求回到末端时把视口送回去 —— 那有两个
   * 入口,一个是他又说了一句话,一个是那枚按钮。
   *
   * 落位有两种,各有各的入口。人亲手要求回到末端时走 travel:那是一段有距离的返回,闪现会
   * 把「我刚才在哪」抹掉。换一条对话时走 resume:那不是返回,是开场 —— 开场不该有位移,而上
   * 一条对话留在这个盒子上的滚动位置更没有资格当这一条的起点。resume 也是唯一做得到的那
   * 一个:stick 只在内容真的长高时才写(见 follow-latest 的 settle),而换对话时高度往往不增
   * 反减。
   *
   * atLatest 只喂那枚按钮的存在。它问的是几何(视口此刻在不在末端),不是意图(要不要跟):
   * 人在末端点开一段内容时两者分叉 —— 意图为假(不该把他拽回去),几何为真(不该冒出一枚
   * 按钮)。两个问题,同一条 staysWithLatest 判据。
   */
  const {
    atLatest,
    release: releaseFollow,
    resume,
    stick,
    travel,
    watch: watchFollow,
  } = useFollowLatest()

  /*
   * 虚拟器此刻铺出来的区间表，给滚动回调里的那次二分用。
   */
  const spansRef = useRef<readonly RowSpan[]>([])

  /*
   * 本帧已经排好的那次几何读取。
   *
   * null 表示没有。一次滚轮滚动派发几十个事件,而它们读的是同一帧的同一份布局:
   * 读第二次不会得到新答案,只会多两次二分和三次 setState。
   */
  const frame = useRef<number | null>(null)
  const earlierRequest = useRef<Promise<void> | null>(null)
  const prependAnchor = useRef<{ readonly id: string; readonly offset: number } | null>(null)
  const correctionFrame = useRef<number | null>(null)

  /*
   * 一次读取，两个派生量。
   *
   * 分开写会读两次几何，还会让两个真源在时间上错开。这里全部是读，没有写夹在
   * 中间，所以不会有强制回流。
   *
   * 不含「人是不是贴在末端」。那个量确实要读，但它归 follow-latest：它读完只写
   * scrollTop，一个 state 都不碰，也就没有理由挤进这次 setState。同一个问题仍然只有
   * 一个答案 —— 只是那个答案在别的文件里，而且量的是 DOM 的末端。
   */
  const syncScrollState = useCallback(
    (viewport: HTMLDivElement) => {
      const spans = spansRef.current
      const reading = rowAtAnchor(
        spans,
        viewport.scrollTop + viewport.clientHeight * READING_ANCHOR_RATIO,
      )

      if (reading !== null) {
        setReadingRow(reading.index)
      }

      /* 顶行只答一件事:那次跳转到了没有。 */
      const top = rowAtAnchor(spans, viewport.scrollTop)

      if (top !== null) {
        const row = feed.rowAt(top.index)

        if (row !== undefined) {
          prependAnchor.current = {
            id: row.item.id,
            offset: top.start - viewport.scrollTop,
          }
        }

        settleReveal(top.index, viewport.scrollTop - top.start <= REVEAL_FLUSH_PX)
      }

      /* 离顶端还有多远。同一次读取里问出来，所以不多一次几何访问。 */
      if (
        hasEarlier &&
        earlierRequest.current === null &&
        viewport.scrollTop < viewport.clientHeight * EARLIER_LEAD_SCREENS
      ) {
        const request = Promise.resolve().then(onReachStart)
        earlierRequest.current = request
        void request.finally(() => {
          if (earlierRequest.current === request) {
            earlierRequest.current = null
          }
        })
      }
    },
    [feed, hasEarlier, onReachStart, settleReveal],
  )

  /*
   * 几何读取一帧一次。
   *
   * 合并到 rAF 之后,读取次数与帧数对齐 —— 那也是浏览器唯一保证布局稳定的
   * 时机。
   */
  const scheduleSync = useCallback(() => {
    if (frame.current !== null) {
      return
    }

    frame.current = requestAnimationFrame(() => {
      frame.current = null

      const viewport = viewportRef.current

      if (viewport !== null) {
        syncScrollState(viewport)
      }
    })
  }, [syncScrollState])

  /*
   * 只听滚动区自己的滚动。
   *
   * 原生 scroll 不冒泡,而 React 的 onScroll 会:它把这类事件委托到根容器捕获,
   * 再沿 React 树模拟一次冒泡。写成 onScroll,代码块、思考过程、工具输出 —— 任何
   * 一个后代滚动容器动一下,这里都会被叫醒,然后拿外层的几何去翻转锚点,整条对话
   * 随之重排。那不是滚动链接,contain 挡不住,它是事件层的串线。
   *
   * 所以监听挂在元素上,由 ref 回调负责装卸:内层滚动在事件层就到不了这里,不需要
   * 任何 target 比对 —— 比对是让错误先进门再赶出去,而这里可以让它根本进不来。
   * passive:读一个已有的几何量,永远不该让滚动等我们。
   *
   * 跳转闩锁的放弃路径也装在这里。它听的是输入设备事件,与滚动同源、同寿、同一个
   * 装卸点 —— 一个滚动区,一处装卸,没有第二条生命周期要维护。
   */
  const bindViewport = useCallback(
    (viewport: HTMLDivElement | null) => {
      viewportRef.current = viewport

      if (viewport === null) {
        return
      }

      viewport.addEventListener('scroll', scheduleSync, { passive: true })

      /* 一个滚动区，一处装卸：两处订阅各自交回自己的卸载函数。 */
      const unwatchFollow = watchFollow(viewport)
      const unwatchReveal = watchReveal(viewport)

      return () => {
        viewport.removeEventListener('scroll', scheduleSync)

        if (frame.current !== null) {
          cancelAnimationFrame(frame.current)
          frame.current = null
        }

        unwatchFollow()
        unwatchReveal()
        viewportRef.current = null
      }
    },
    [scheduleSync, watchFollow, watchReveal],
  )

  /*
   * 条目的身份函数，依赖如实声明。
   *
   * 身份是 id 不是序号：恢复会话与回填历史都会让每一条换序号，用序号当身份，锚点会在
   * 那之后落到别的条目上。官方点名过这一条 ——「Index keys cannot distinguish prepends
   * from appends after items shift」。
   *
   * 依赖是投影，不是一份在渲染期写进去的镜像。React 的规矩没有例外：渲染必须是纯的，
   * ref 不在渲染期读写（Referencing Values with Refs 逐字：Do not write or read
   * ref.current during rendering）。StrictMode 会把渲染跑两遍，并发渲染会丢弃渲染 ——
   * 镜像因此不是一次优化，是一次赌它不行使这个权利。
   *
   * 换掉的代价是可算的：getItemKey 换身份只让虚拟器
   * 重算 measurements 这一层备忘（它的依赖里有 getItemKey），而实测高度存在以 item key
   * 为索引的 itemSizeCache 里，不随之作废 —— 重算是纯算术，measureElement 一次都不会
   * 被重新调用。「每帧全表重测」从来没有发生过。
   */
  const getItemKey = useCallback((index: number) => feed.rowAt(index)?.item.id ?? index, [feed])

  const virtualizer = useVirtualizer({
    count: feed.count,
    getScrollElement: () => viewportRef.current,
    estimateSize: estimateRow,
    getItemKey,
    scrollMargin,
    paddingEnd: tailSize,
    overscan: OVERSCAN_ROWS,
    /*
     * 滚动停没停，问浏览器。
     *
     * 这个选项默认 false，库于是退回一个 isScrollingResetDelay 的定时器去猜。官方
     * 写明了那条退路存在的理由：「until all browsers uniformly support the scrollEnd
     * event」。这里的渲染器是 WebView2，只有 Chromium，原生 scrollend 早已可用 ——
     * 一个为跨浏览器差异准备的降级，在一个单引擎的桌面应用里只是一个会晚 150ms
     * 的猜测。
     */
    useScrollendEvent: true,
  })

  const items = virtualizer.getVirtualItems()

  /*
   * 区间表在提交之后镜像一次。
   *
   * 它唯一的读者是滚动回调里的那次二分，而回调永远发生在提交之后 —— 所以这份镜像
   * 没有任何理由写在渲染期，也就不必违反渲染纯度。
   */
  useLayoutEffect(() => {
    spansRef.current = items
  }, [items])

  /*
   * 自己说的话把视线带回末端。
   *
   * 专业软件在这里是一致的:发出去之后视线回到底部,因为那是答复将要出现的地方 —— 停在半
   * 空是把「我在读历史」这个已经作废的意图当成了当前意图。
   *
   * 触发者是数据而不是点击:最后一条我说的话换了 id,就是我又说了一句。所以输入框不必把
   * 发送事件传进滚动区,而「恢复会话」「重新发送」这些同样该回到末端的情形自动成立。
   *
   * travel 自己会把视口送到末端,所以这里不必再叫 stick:重新跟上与回到末端是同一次动作。
   * 从很上面发出去时那一段位移是看得见的 —— 那是刻意的,读者要知道自己被带去了哪里。
   *
   * 判据必须是「同一条对话里,两个真实 id 之间的更替」。少了对话身份那一半,换一条对话时
   * 「最后一条我说的话」也换了 id,于是「进了一条旧对话」被判成「我又说了一句」,走的是带缓
   * 动的位移 —— 从上一条对话残留的滚动位置一路滑到末端,那正是进旧对话时看见的那一下。转
   * 录仍然是异步灌进来的(恢复会话时它先是空的,RestoreSpinner 就为这一刻存在),所以 null 到
   * id 那一跳照旧不算。
   *
   * 代价说清楚:会话里的第一句话不走位移。那时转录本来就没有距离可走。
   *
   * 末两项比较不是冗余:travel 与 resume 的身份随「减弱动态偏好」变化,效应会因此在 id 没变
   * 时重跑。
   */
  const ownMessage = feed.latestOwnMessage
  const said = useRef<{ readonly conversation: string; readonly message: string | null } | null>(
    null,
  )

  useLayoutEffect(() => {
    const before = said.current

    said.current = { conversation, message: ownMessage }

    /* 换了一条对话,或者这个盒子刚挂上:瞬时落到末端,一帧位移都不产生。resume 而不是 stick
       —— 人可能在上一条对话里翻着历史,跟随此刻是让开的状态,而 stick 还要等内容长高。 */
    if (before === null || before.conversation !== conversation) {
      resume()

      return
    }

    if (before.message === null || ownMessage === null || before.message === ownMessage) {
      return
    }

    travel()
  }, [conversation, ownMessage, resume, travel])

  /*
   * 内容长高了,就拨一次末端。
   *
   * 水位线在这一层是已知数:转录框的高度由虚拟器算出,尾部的高度由观察它的那条通知带来,
   * 两者相加就是滚动盒里的内容高度。不经过 React 的那些长高(图片解码完成、公式与图表
   * 排版)也含在里面 —— 它们改变行的实测高度,虚拟器随之改总高。
   *
   * 于是跟随只在真的长高时读一次几何,而写者只剩这一处。
   */
  const contentHeight = virtualizer.getTotalSize() + tailSize

  useLayoutEffect(() => {
    stick(contentHeight)
  }, [contentHeight, stick])

  /*
   * 量，然后交出去。这里一个字都不写回 DOM。
   *
   * 偏移是交给虚拟器的一个输入，而写滚动位置是 follow-latest 的事，两件事在这里不该
   * 合流：这个回调由 ResizeObserver 叫醒，而此刻新的高度还没提交，任何在这里写下的
   * 滚动位置都会被浏览器夹掉 —— 那也正是库自己的增量补偿会丢步的地方。
   */
  const measureMargin = useCallback(() => {
    const transcript = transcriptRef.current

    if (transcript !== null) {
      setScrollMargin(transcript.offsetTop)
    }
  }, [])

  /*
   * 尺寸变了,同一个滚动位置就对应到另一行上。
   *
   * 流式输出把行撑高、面板被拖窄、抽屉展开 —— 三者都改变几何,都不产生滚动
   * 事件。ResizeObserver 是这个通知的官方形态,而且它连不经过 React 的尺寸变化
   * (图片解码完成、字体换页)也一并覆盖。
   */
  useLayoutEffect(() => {
    const viewport = viewportRef.current

    if (viewport === null) {
      return
    }

    /*
     * 尺寸变了，两件事都要重做：同一个滚动位置对应到哪一行、转录相对滚动区的偏移。偏移
     * 必须在这里重算而不能只靠行数变化去带 —— 面板被拖窄时行数一行都不变，而滚动区的
     * 内边距与页眉都变了。
     *
     * 两个量都不来自转录的高度：偏移由滚动区的内边距与页眉决定，随滚动区一起变；尾部的
     * 高度由派发它的那条通知自己带着。这一点是下面把转录也放进名单的前提 —— 否则「尺寸
     * 变化叫醒回调、回调改高度、高度再叫醒回调」就闭合成一条回路，也就是「ResizeObserver
     * loop completed with undelivered notifications」的成因。
     */
    const observer = new ResizeObserver((entries) => {
      /* 偏移只由滚动区自己决定：转录框长高不动它的顶边，而流式输出时它每一帧都在长。 */
      let moved = false

      for (const entry of entries) {
        if (entry.target === viewport) {
          moved = true
        }

        /* 尾部的高度由派发它的那条通知自己带着,理由见下面观察它的那一句。 */
        if (entry.target === tailRef.current) {
          const [box] = entry.borderBoxSize

          if (box !== undefined) {
            setTailSize(box.blockSize)
          }
        }
      }

      if (moved) {
        measureMargin()
      }

      scheduleSync()
    })

    observer.observe(viewport)

    /*
     * 转录框也在观察名单上。
     *
     * 它的高度就是 getTotalSize(),流式输出时每一帧都在长,所以回路接不上这件事必须逐句
     * 成立:回调里那两句都写 state,而它们都在值没变时被 React 挡掉 —— 偏移不随转录框自身
     * 的高度变化,视线所在的行只在跨行时才是新值。
     *
     * 要它的理由是它盖住了另外两个盖不到的东西:行内的异步排版(图片解码、公式、图表),
     * 以及抽屉展开引起的高度变化。
     */
    if (transcriptRef.current !== null) {
      observer.observe(transcriptRef.current)
    }

    /*
     * 尾部要按边框盒观察，这不是一个可选项。
     *
     * 这个盒子的高度整个来自 padding-block-end（--cp-dock-clearance 加一段
     * 溶解带，见 agent-activity-feed.css）；它的内容盒里只有等待指示器，空闲
     * 时是 0。而 ResizeObserver 默认观察 content-box —— 内边距变化不派发。
     *
     * 于是输入框长高、问题面板长出来、或者 dock-clearance 在首帧之后才第一次
     * 写入真实高度时，实物长高了，而交给虚拟器的 paddingEnd 还停在旧值：转录
     * 框按旧值定高，尾部按新值向上占位，多出来的那一截压在最后几行上，正好被
     * 输入框盖住。滑到滚动条尽头，虚拟器认为到底了，内容还没到底。
     *
     * 冷启动必现：挂载时 clearance 还没被写，var() 走回退值 --cp-gutter，首测
     * 就偏小，而通知永远不来。一轮对话开头或结尾「自己好一下」，是等待指示器
     * 的出现与消失改变了内容盒，顺带把当时的正确值读了回来。
     *
     * 而这个量不必回头去 DOM 里问一遍:观察者派发的 entry.borderBoxSize 就是它
     * 本身,且是分数。offsetHeight 同样是边框盒,但它取整 —— 而这个盒子的高度整个
     * 来自 --cp-dock-clearance,那个数由 dock-clearance 用同一个 borderBoxSize 写入,
     * 本身就带小数。取整一次,交给虚拟器的 paddingEnd 就与实物差最多半个像素,而半个
     * 像素正是上面 snapToDevicePixels 存在的全部理由。
     *
     * 转录的偏移仍是一次 offsetTop:转录派发的通知只带着它自己的尺寸,而偏移是它与滚动
     * 区之间的距离,没有哪一条通知会捎带这个量。
     */
    if (tailRef.current !== null) {
      observer.observe(tailRef.current, { box: 'border-box' })
    }

    return () => {
      observer.disconnect()
    }
  }, [measureMargin, scheduleSync])

  /*
   * 跳转是意图的效应,不是点击的副作用。
   *
   * 跳转必须发生在闩锁已经立起来之后 —— 那次滚动自己会派发 scroll,而回调里的
   * settleReveal 拿它去回答「到了没有」。pending 还没提交就滚,这一问会被自己的
   * 滚动提前答成「到了」。放进效应里,顺序由 React 保证,不由调用顺序碰运气。
   *
   * 位移与「回到最新」是同一种运动,走同一条管线(scroll-glide):目标每帧从虚拟器
   * 重读 —— getOffsetForIndex 正是 scrollToIndex 内部用的那次换算。途中行被真高
   * 替换、总高改变,下一帧的目标就跟着新几何走,不会钉死在一个已经不存在的位置上;
   * 途中每帧仍只挂载落点附近的一窗行,一段位移几十帧,代价与人快速滚一遍相同,有
   * 界。平台的平滑滚动做不到这些:时长曲线由 UA 定、目标只在开始时捕获一次、收尾
   * 还会被程序化写入提前放行。
   *
   * 取消不用额外接线:人一动输入设备,useRevealIntent 放弃 pending,这个效应的清理
   * 函数当场停掉循环。跳转之前 releaseFollow 已经让开,末端不再来抢。减弱动效下退
   * 化成瞬移,与「回到最新」同一条规则。
   */
  useLayoutEffect(() => {
    if (pending === null) {
      return
    }

    if (reduced === true) {
      virtualizer.scrollToIndex(pending, { align: 'start' })

      return
    }

    const viewport = viewportRef.current

    if (viewport === null) {
      return
    }

    return startGlide(viewport, {
      arrive: () => settleReveal(pending, true),
      proceed: () => viewportRef.current !== null,
      target: () => virtualizer.getOffsetForIndex(pending, 'start')?.[0] ?? null,
    })
  }, [pending, reduced, settleReveal, virtualizer])

  /* Preserve the first visible stable row, then reconcile estimates against DOM
   * measurements until the pixel offset has settled. */
  const firstSeen = useRef<string | null>(null)

  useLayoutEffect(() => {
    const before = firstSeen.current
    const first = feed.rowAt(0)?.item.id ?? null
    firstSeen.current = first

    const anchor = prependAnchor.current
    const viewport = viewportRef.current
    const transcript = transcriptRef.current

    if (before === null || first === null || before === first || anchor === null) {
      return
    }

    const moved = feed.indexOf(anchor.id)
    const estimated = moved < 0 ? undefined : virtualizer.getOffsetForIndex(moved, 'start')?.[0]

    if (viewport === null || transcript === null || estimated === undefined) {
      return
    }

    virtualizer.scrollToOffset(estimated - anchor.offset)

    let frames = 0
    let stable = 0
    let stopped = false

    const correct = () => {
      if (stopped || viewportRef.current !== viewport) {
        return
      }

      frames += 1
      const row = [...transcript.querySelectorAll<HTMLElement>('[data-row-id]')].find(
        (element) => element.dataset['rowId'] === anchor.id,
      )

      if (row !== undefined) {
        const delta =
          row.getBoundingClientRect().top - viewport.getBoundingClientRect().top - anchor.offset

        if (Math.abs(delta) <= 0.5) {
          stable += 1
        } else {
          stable = 0
          viewport.scrollTop += delta
        }
      }

      if (stable < 3 && frames < 60) {
        correctionFrame.current = requestAnimationFrame(correct)
      } else {
        correctionFrame.current = null
      }
    }

    correctionFrame.current = requestAnimationFrame(correct)

    return () => {
      stopped = true
      if (correctionFrame.current !== null) {
        cancelAnimationFrame(correctionFrame.current)
        correctionFrame.current = null
      }
    }
  }, [feed, virtualizer])
  /*
   * 高亮的真源,按优先级排。
   *
   * 人刚要求看的那一轮最权威;其次是视线推出来的那一行;两者都还没有的那一帧 ——
   * 只有首帧 —— 是末尾,因为上面的布局效应刚把视口送到那里。
   */
  const activeRow = pending ?? readingRow ?? Math.max(0, feed.count - 1)

  const scrollToRow = useCallback(
    (index: number) => {
      /*
       * 跳转是人下的指令,自动跟随是默认行为,指令高于默认 —— 所以先让开,再跳。
       *
       * 让开是粘滞的,由「人自己滚回末端」解除,不由这次跳转落定解除:落点在上面,落定
       * 的那一刻人正看着历史。
       */
      releaseFollow()
      beginReveal(index)
    },
    [beginReveal, releaseFollow],
  )

  return (
    <div className="agent-activity-feed">
      <div className="agent-activity-feed__viewport" ref={bindViewport}>
        <div
          aria-busy={isBusy}
          className="agent-activity-feed__transcript"
          ref={transcriptRef}
          role="log"
          style={{ height: virtualizer.getTotalSize() }}
        >
          {/*
           * 每行各自落位。
           *
           * 官方对布局策略给过两处建议，前提不同，上一版只引了一处就下了断言，
           * 这里如实写全：
           *
           *   Chat 指南 —— position absolute，transform 平移到 item.start。
           *   scrollToIndex 注记 —— 平滑滚动时首选「整块平移」，因为平滑滚动期间
           *     虚拟器只测量目标附近缓冲区内的条目，跳过的那些若各自定位就会错位。
           *
           * 本组件落在前者，理由是后者的前提在这里不存在：这里没有平台的平滑
           * 滚动。跳转与「回到最新」是 scroll-glide 的逐帧写入 —— 对虚拟器而言
           * 每一帧都是一次普通的瞬时落位，目标行附近照常挂载与测量；持续跟随是
           * 一次 scrollTop 赋值。目标偏移每帧重读，所以「它会自己跑掉」不成立。
           *
           * 于是这里取一致性：每一行都坐在虚拟器算出来的 start 上，模型说它在哪
           * 它就在哪。走文档流则只有首行的位置来自虚拟器，其余来自前面各行的真实
           * 高度 —— 那是第二个来源，且与虚拟器的表差着一次异步测量。
           *
           * 代价是每个可见行一个内联 style 对象，约十几个每帧。
           */}
          {items.map((item) => {
            const row = feed.rowAt(item.index)

            if (row === undefined) {
              return null
            }

            return (
              <div
                className="agent-activity-feed__row"
                data-index={item.index}
                data-row-id={row.item.id}
                data-streaming={row.isStreamingTail ? 'true' : undefined}
                data-type={row.item.type}
                key={item.key}
                ref={virtualizer.measureElement}
                style={{
                  transform: `translateY(${String(snapToDevicePixels(item.start - scrollMargin))}px)`,
                }}
              >
                {renderRow(item.index)}
              </div>
            )
          })}
          {/* 末端的清空距离，坐在 paddingEnd 预留出来的那块空间里；实测高度反过来就是它。 */}
          <div className="agent-activity-feed__tail" ref={tailRef} />
        </div>
      </div>

      {/*
       * 回到最新。
       *
       * 常驻挂载,靠 data-shown 在两个静态状态之间过渡 —— 它不需要 AnimatePresence 解决的
       * 那个问题(元素卸载时还要播退场),所以时长与曲线可以直接吃样式表里的令牌,一个新数字
       * 都不用造,减弱动态偏好也由那张表里既有的查询接住。
       *
       * 隐藏时挂 inert:一个 opacity 为 0 的按钮仍然可点、仍然进得了 Tab 序 —— inert 是
       * 官方给「这块东西现在不存在」的声明,与 DisclosureBody 收起时用的是同一个属性。
       *
       * 判据是 atLatest 而不是 isBusy:人离开末端与模型在不在跑无关,这枚按钮回答的是「下面
       * 还有我没看见的东西」。标杆同一形状 —— AI Elements 的 ConversationScrollButton 也是
       * !isAtBottom 才出现。
       */}
      <button
        aria-label="回到最新"
        className="agent-activity-feed__to-latest"
        data-shown={atLatest ? undefined : 'true'}
        inert={atLatest}
        onClick={travel}
        type="button"
      >
        <ChevronDownIcon aria-hidden="true" />
      </button>

      {overlay === undefined ? null : overlay({ activeRow, scrollToRow })}
    </div>
  )
}
