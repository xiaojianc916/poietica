import './agent-activity-feed.css'

import type { Presentation } from '@poietica/conversation'
import { useVirtualizer, type VirtualItem } from '@tanstack/react-virtual'
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { ChevronDownIcon } from '../primitives/icons'
import { useDevicePixels } from '../primitives/use-device-pixels'
import { geometryOf, keepGeometry } from './conversation-geometry'
import { rowAtAnchor } from './reading-position'
import { useScrollAuthority } from './scroll-authority'

/*
 * 视口之外预留的行数。
 *
 * 首帧只铺一屏多一点：那时行高多半还是估的，铺得越多越是白测。两帧之后几何已经稳了，
 * 抬到能盖住一次快滚的量。少了快滚露白，多了白测量，所以是两级而不是一个折中值。
 */
const OVERSCAN_COLD = 6
const OVERSCAN_SETTLED = 20

/**
 * 视线在视口里的位置，自上而下的比例。
 *
 * 上沿是一条边，上一轮的残留一个像素就占住它；三分之一处是人真正在看的地方。
 */
const READING_ANCHOR_RATIO = 1 / 3

/** 距顶端不足这么多屏就去要更早的一页：触顶才取，看见的就是一次停顿。 */
const EARLIER_LEAD_SCREENS = 1

/** 距末端不足这么多像素算在末端：一格滚轮的量。虚拟器据此决定跟不跟随。 */
const END_THRESHOLD_PX = 48

/**
 * 浮层可以向滚动区要什么。行号，不是像素。
 */
export interface FeedPort {
  /** 人正在读的那一行；跳转期间是人要求看的那一行。 */
  readonly activeRow: number
  readonly scrollToRow: (index: number) => void
}

/** 一行按哪一档节奏排：左图标右文字的一条记事，或一段正文。行距因此只有两个数。 */
export type RowRhythm = 'glyph' | 'prose'

export interface AgentActivityFeedProps {
  /**
   * 这些行属于哪一条对话。
   *
   * 盒子按它取 key，所以一条对话一个盒子；它同时是这条对话行高量表的名字。
   */
  readonly conversation: string
  readonly feed: Presentation
  /**
   * 开合表：封条与抽屉，人亲手改的那一份。这一层只认它的身份 —— 换一个身份 = 这一
   * 帧的高度变化是人点出来的。
   *
   * virtual-core 的 resizeItem 在 anchorTo 为 end 且人本来就在末端时，把长高的量补进
   * scrollTop 去钉住底边。模型吐字时这正是「跟着流走」；人点开面板时同一个补偿就是整屏
   * 往上蹿一段。区别只在这次高度变化是谁引起的。
   */
  readonly disclosed: object
  /** 一行还没被测量时有多高。类别知识归转录那一侧。 */
  readonly estimateRow: (index: number) => number
  /** 这一行按哪一档节奏排。同上，类别知识归转录那一侧。 */
  readonly rowRhythm: (index: number) => RowRhythm
  readonly renderRow: (index: number) => ReactNode
  readonly isBusy: boolean
  /** 覆盖转录的输入区高度；null 表示首帧布局尚未落定。 */
  readonly dockClearance: number | null
  /** 上面还有没有更早的一页。 */
  readonly hasEarlier: boolean
  /** 顶端快见底了。读不读、读几页归转录那一侧。 */
  readonly onReachStart: () => Promise<void>
  /** 转录之前那一块常驻内容。它在滚动盒里,所以跟着滚,并与转录共用阅读栏宽。 */
  readonly lead?: ReactNode
  /** 画在滚动区之上，位于一切会滚的东西之外。 */
  readonly overlay?: (port: FeedPort) => ReactNode
}

/**
 * 会话流的滚动区。
 *
 * 它铺内容、量几何，一个 scrollTop 都不写：位置归虚拟器，意图归 scroll-authority。
 *
 * 它不认识条目类型：内容与估高都从插槽进来。
 */
export function AgentActivityFeed({
  conversation,
  disclosed,
  dockClearance,
  estimateRow,
  feed,
  hasEarlier,
  isBusy,
  lead,
  onReachStart,
  overlay,
  renderRow,
  rowRhythm,
}: AgentActivityFeedProps) {
  /** 滚动区的生命周期归这一个 state：装卸不再随任何 prop 变化而重做。 */
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null)
  const transcriptRef = useRef<HTMLDivElement | null>(null)
  const leadRef = useRef<HTMLDivElement | null>(null)

  /**
   * 行的落点要踩在设备像素上：落在半个设备像素上，这一行里所有 1px 的边会被摊到两行、
   * 墨色减半。位置只有一个写入点，对齐也只需要一个。
   */
  const snapToDevicePixels = useDevicePixels()

  /**
   * 转录相对滚动区的偏移。滚动区是转录的 offsetParent，所以这是一次 offsetTop。
   *
   * 是 state 而不是 ref：虚拟器在渲染期读它。
   */
  const [scrollMargin, setScrollMargin] = useState<number | null>(null)

  /** 视线落在哪一行。null 是「还没读到过」，不是第 0 行。 */
  const [readingRow, setReadingRow] = useState<number | null>(null)

  /** 虚拟器此刻铺出来的区间表，给那两次二分用。提交之后镜像一次。 */
  const spansRef = useRef<readonly VirtualItem[]>([])
  const earlierRequest = useRef<Promise<void> | null>(null)

  /* 向上续读的最新入参。滚动区一处装卸，所以这两个 prop 不进监听器的依赖。 */
  const earlier = useRef({ hasEarlier, onReachStart })

  useLayoutEffect(() => {
    earlier.current = { hasEarlier, onReachStart }
  }, [hasEarlier, onReachStart])

  /* 身份是 id 不是序号：回填历史会让每一条换序号，用序号当锚点就落到别的条目上。 */
  const getItemKey = useCallback((index: number) => feed.rowAt(index)?.item.id ?? index, [feed])

  /* 几何只在挂载那一次被收走，所以只取一次。 */
  const [restored] = useState(() => geometryOf(conversation))

  /* 两项都在布局阶段落定，错误的首帧几何不会上屏。 */
  const settled = scrollMargin !== null && dockClearance !== null

  /*
   * 人点开抽屉的那一帧，末端锚定让位给起始锚定：那时要钉的是被点的那一行。
   *
   * 归位的判据是总高变了，不是提交完了 —— 行的测量由 ResizeObserver 异步送达。
   */
  const [held, setHeld] = useState(disclosed)
  const holding = held !== disclosed
  const measuredTotal = useRef(0)

  const { atLatest, pinned, reveal, revealing, sample, travel, watch } = useScrollAuthority(
    restored?.reading ?? null,
  )

  /* 这些令牌注册为 length，getComputedStyle 因而返回可直接相加的像素值。 */
  const metrics = useMemo(() => {
    if (viewport === null) {
      return { dissolve: 0, glyph: 0, prose: 0 }
    }

    const style = getComputedStyle(viewport)
    const read = (token: string) => Number.parseFloat(style.getPropertyValue(token)) || 0

    return {
      dissolve: read('--cp-dock-dissolve'),
      glyph: read('--cp-feed-glyph-row-gap'),
      prose: read('--cp-feed-prose-row-gap'),
    }
  }, [viewport])

  /** 这一行的内容顶比盒顶低多少。 */
  const leadOf = (row: number) => metrics[rowRhythm(row)]
  const paddingEnd = dockClearance === null ? 0 : dockClearance + metrics.dissolve

  const virtualizer = useVirtualizer({
    /* 落点 = item.start - scrollPaddingStart：被揭示的行之上留一格行距。 */
    scrollPaddingStart: revealing === null ? 0 : leadOf(revealing),
    count: feed.count,
    getScrollElement: () => viewport,
    estimateSize: estimateRow,
    getItemKey,
    /* 交出副本：这份会被虚拟器收走当自己的初值。空表与库默认等价。 */
    initialMeasurementsCache: restored === undefined ? [] : [...restored.rows],
    scrollMargin: scrollMargin ?? 0,
    paddingEnd,
    overscan: settled ? OVERSCAN_SETTLED : OVERSCAN_COLD,
    /* 尾部锚定：前插不动眼前那一行，末端跟随只在人本来就在末端时发生。 */
    anchorTo: holding ? 'start' : 'end',
    followOnAppend: !holding,
    scrollEndThreshold: END_THRESHOLD_PX,
    /* 滚动停没停问浏览器：库那条 isScrollingResetDelay 的退路是为跨浏览器差异准备的，
       而这里的渲染器只有 Chromium，原生 scrollend 早已可用。 */
    useScrollendEvent: true,
  })

  /*
   * 长高的量只补视口之上那些行：落点行自己被量出与估高之差时，不该把落点推走。
   * 装好的 virtual-core 里这一格是实例字段，不是选项 —— 传进选项表会被静默忽略。
   */
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) =>
    item.start + leadOf(item.index) < (instance.scrollOffset ?? 0)

  const total = virtualizer.getTotalSize()

  /*
   * 末端的坐标：偏移加总高（总高含尾部那段清空距离）。两段都是分帧到的 —— 偏移与尾部
   * 各等一次 ResizeObserver，行高等实测 —— 所以落到末端只能是一份持续意图，坐标一动
   * 就重钉一次。挂载那一次命令钉的是「还没量到这两段」的假末端，真值到达后就停在离底
   * 一段的地方，而那一段正是尾部清空距离。
   *
   * 钉末端还是钉某一行由意图那一层说，这里只负责在坐标变化时把同一份意图重写一次。
   * 行高变化的补偿归虚拟器（anchorTo/followOnAppend）；坐标没动就不写。
   */
  const end = (scrollMargin ?? 0) + total

  /* 这一份意图落在哪个坐标上。意图或坐标变了才重写一次，两者都没变就什么都不做。 */
  const intent =
    revealing === null
      ? pinned
        ? `end:${String(end)}`
        : null
      : `row:${String(revealing)}:${String(end)}`
  const wroteAt = useRef<string | null>(null)

  useLayoutEffect(() => {
    if (intent === null) {
      /* 意图撤了：同一行再点一次仍然要写一次位置。 */
      wroteAt.current = null

      return
    }

    if (viewport === null || !settled || wroteAt.current === intent) {
      return
    }

    wroteAt.current = intent

    if (revealing === null) {
      virtualizer.scrollToEnd()

      return
    }

    /* 人要求看的那一行最权威：请求由 scrollend 了结，所以这一路自己会停。 */
    virtualizer.scrollToIndex(revealing, { align: 'start' })
  }, [intent, revealing, settled, viewport, virtualizer])

  /* 那一次长高量到了，锚定当场归位：让位只覆盖人点出来的那一次测量。 */
  useLayoutEffect(() => {
    if (holding && total === measuredTotal.current) {
      return
    }

    measuredTotal.current = total
    setHeld(disclosed)
  }, [disclosed, holding, total])

  const items = virtualizer.getVirtualItems()

  useLayoutEffect(() => {
    spansRef.current = items
  }, [items])

  /* 意图与视线的最新值。走的时候要读它们，而那一次装卸只随对话变化。 */
  const seen = useRef<{ pinned: boolean; reading: number | null }>({
    pinned: true,
    reading: null,
  })

  useLayoutEffect(() => {
    seen.current = { pinned, reading: readingRow }
  }, [pinned, readingRow])

  /* 走的时候把几何留下：下次打开这条对话，总高与视线都从这一份起。 */
  useLayoutEffect(
    () => () => {
      keepGeometry(conversation, {
        rows: virtualizer.takeSnapshot(),
        /* 在末端就不记行号：回来时继续跟随末端，而不是钉死在当时的最后一行。 */
        reading: seen.current.pinned ? null : seen.current.reading,
      })
    },
    [conversation, virtualizer],
  )

  /* 滚动、尺寸观察和阅读锚点共享滚动盒的生命周期。 */
  useLayoutEffect(() => {
    if (viewport === null) {
      return
    }

    let frame: number | null = null

    const sync = () => {
      if (frame !== null) {
        return
      }

      frame = requestAnimationFrame(() => {
        frame = null

        const spans = spansRef.current
        const reading = rowAtAnchor(
          spans,
          viewport.scrollTop + viewport.clientHeight * READING_ANCHOR_RATIO,
        )

        if (reading !== null) {
          setReadingRow(reading.index)
        }

        /* 末端判据归虚拟器，这里只在同一次布局读取里采样。 */
        sample(virtualizer.isAtEnd())

        /* 离顶端还有多远，同一次读取里问出来。 */
        if (
          earlier.current.hasEarlier &&
          earlierRequest.current === null &&
          viewport.scrollTop < viewport.clientHeight * EARLIER_LEAD_SCREENS
        ) {
          const request = Promise.resolve().then(earlier.current.onReachStart)

          earlierRequest.current = request
          void request.finally(() => {
            if (earlierRequest.current === request) {
              earlierRequest.current = null
            }
          })
        }
      })
    }

    /*
     * 转录也在名单上：它盖住行内的异步排版与抽屉展开。回路接不上，因为回调写的都是
     * state，而 React 在值没变时挡掉 —— 偏移不随转录自身的高度变化，视线所在的行只在
     * 跨行时才是新值。
     *
     * 尾部按边框盒观察不是可选项：它的高度整个来自 padding-block-end，而默认的
     * content-box 不因内边距变化派发，于是 paddingEnd 会一直停在冷启动那一测。
     */
    const observer = new ResizeObserver(() => {
      if (transcriptRef.current !== null) {
        setScrollMargin(transcriptRef.current.offsetTop)
      }

      sync()
    })

    observer.observe(viewport)

    if (transcriptRef.current !== null) {
      const transcript = transcriptRef.current

      /* 与尾部同一条纪律：首次通知晚于首帧，挂载时先同步读一次。 */
      setScrollMargin(transcript.offsetTop)
      observer.observe(transcript)
    }

    if (leadRef.current !== null) {
      observer.observe(leadRef.current)
    }

    viewport.addEventListener('scroll', sync, { passive: true })

    const unwatch = watch(viewport, () => virtualizer.isAtEnd())

    return () => {
      if (frame !== null) {
        cancelAnimationFrame(frame)
      }

      viewport.removeEventListener('scroll', sync)
      observer.disconnect()
      unwatch()
    }
  }, [sample, viewport, virtualizer, watch])

  /*
   * 自己说的话把视线带回末端：那是答复将要出现的地方。
   *
   * 触发者是数据 —— 最后一条我说的话换了 id。一条对话一个盒子，所以换对话走挂载那一路，
   * 不会被当成「我又说了一句」。
   */
  const ownMessage = feed.latestOwnMessage
  const said = useRef<{ readonly message: string | null } | null>(null)

  useLayoutEffect(() => {
    const spoken = said.current

    said.current = { message: ownMessage }

    if (spoken === null || spoken.message === null || ownMessage === null) {
      return
    }

    if (spoken.message !== ownMessage) {
      travel()
    }
  }, [ownMessage, travel])

  /* 人刚要求看的那一轮最权威；其次是视线推出来的那一行；首帧两者都还没有，那时在末尾。 */
  const activeRow = revealing ?? readingRow ?? Math.max(0, feed.count - 1)

  return (
    <div
      className="agent-activity-feed"
      style={{ '--cp-dock-clearance': `${String(dockClearance ?? 0)}px` } as CSSProperties}
    >
      <div className="agent-activity-feed__viewport" ref={setViewport}>
        {lead === undefined ? null : (
          <div className="agent-activity-feed__lead" ref={leadRef}>
            {lead}
          </div>
        )}

        <div
          aria-busy={isBusy}
          className="agent-activity-feed__transcript"
          ref={transcriptRef}
          role="log"
          style={{ height: total }}
        >
          {/* 每行坐在虚拟器算出来的 start 上：模型说它在哪它就在哪，位置只有一个来源。 */}
          {items.map((item) => {
            const row = feed.rowAt(item.index)

            if (row === undefined) {
              return null
            }

            return (
              <div
                className="agent-activity-feed__row"
                data-index={item.index}
                data-rhythm={rowRhythm(item.index)}
                data-streaming={row.isStreamingTail ? 'true' : undefined}
                key={item.key}
                ref={virtualizer.measureElement}
                style={{
                  transform: `translateY(${String(snapToDevicePixels(item.start - (scrollMargin ?? 0)))}px)`,
                }}
              >
                {renderRow(item.index)}
              </div>
            )
          })}
        </div>
      </div>

      {/*
       * 回到最新。常驻挂载，靠 data-shown 在两个静态状态之间过渡。
       *
       * 隐藏时挂 inert：一个 opacity 为 0 的按钮仍然可点、仍然进得了 Tab 序。
       * 判据是 atLatest 而不是 isBusy：它回答的是「下面还有我没看见的东西」。
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

      {overlay === undefined ? null : overlay({ activeRow, scrollToRow: reveal })}
    </div>
  )
}
