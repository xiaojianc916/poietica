import './agent-activity-feed.css'

import type { Presentation } from '@poietica/agent'
import { defaultRangeExtractor, useVirtualizer, type VirtualItem } from '@tanstack/react-virtual'
import { type ReactNode, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ChevronDownIcon } from '../primitives/icons'
import { useDevicePixels } from '../primitives/use-device-pixels'
import { rowAtAnchor } from './reading-position'
import { keepMeasurements, measurementsOf } from './row-measurements'
import { type ScrollCommands, useScrollAuthority } from './scroll-authority'

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

export interface AgentActivityFeedProps {
  /**
   * 这些行属于哪一条对话。
   *
   * 盒子按它取 key，所以一条对话一个盒子；它同时是这条对话行高量表的名字。
   */
  readonly conversation: string
  readonly feed: Presentation
  /** 一行还没被测量时有多高。类别知识归转录那一侧。 */
  readonly estimateRow: (index: number) => number
  readonly renderRow: (index: number) => ReactNode
  readonly isBusy: boolean
  /** 上面还有没有更早的一页。 */
  readonly hasEarlier: boolean
  /** 顶端快见底了。读不读、读几页归转录那一侧。 */
  readonly onReachStart: () => Promise<void>
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
  estimateRow,
  feed,
  hasEarlier,
  isBusy,
  onReachStart,
  overlay,
  renderRow,
}: AgentActivityFeedProps) {
  /** 滚动区的生命周期归这一个 state：装卸不再随任何 prop 变化而重做。 */
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null)
  const transcriptRef = useRef<HTMLDivElement | null>(null)
  const tailRef = useRef<HTMLDivElement | null>(null)

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
  const [scrollMargin, setScrollMargin] = useState(0)

  /** 转录之后那一段空间，交给 paddingEnd，于是末端只有一个定义。数值实测，不抄令牌。 */
  const [tailSize, setTailSize] = useState(0)

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

  /* 量表只在挂载那一次被收走，所以只取一次。 */
  const [restored] = useState(() => measurementsOf(conversation))

  const [overscan, setOverscan] = useState(OVERSCAN_COLD)

  /* 视口高度，随视线一并采样：钉行的判据要拿它比，而渲染期不该再问一次布局。 */
  const viewHeight = useRef(0)

  /* 这一帧要额外钉住的行。跳变发生的那一帧有值，下一帧自然清空。 */
  const pinned = useRef<readonly number[]>([])

  /* 上一帧的总高。跳变就是它与这一帧的差。 */
  const measured = useRef(0)

  const virtualizer = useVirtualizer({
    count: feed.count,
    getScrollElement: () => viewport,
    estimateSize: estimateRow,
    getItemKey,
    /* 上次量到的行高。冷启不必从头量一遍，首帧的总高就是对的。空表与库默认等价。 */
    initialMeasurementsCache: restored ?? [],
    scrollMargin,
    paddingEnd: tailSize,
    overscan,
    /* 尾部锚定：前插不动眼前那一行，末端跟随只在人本来就在末端时发生。 */
    anchorTo: 'end',
    followOnAppend: true,
    scrollEndThreshold: END_THRESHOLD_PX,
    /* 钉住的行照铺，别让一次几何跳变把人正在看的行挤出区间。 */
    rangeExtractor: (range) => {
      const rows = defaultRangeExtractor(range)
      const held = pinned.current

      return held.length === 0
        ? rows
        : [...new Set([...rows, ...held])].filter((row) => row < range.count).sort((a, b) => a - b)
    },
    /* 滚动停没停问浏览器：库那条 isScrollingResetDelay 的退路是为跨浏览器差异准备的，
       而这里的渲染器只有 Chromium，原生 scrollend 早已可用。 */
    useScrollendEvent: true,
  })

  /* 位置的写入权在虚拟器，所以意图那一层只透过这三件事说话。 */
  const commands = useMemo<ScrollCommands>(
    () => ({
      isAtEnd: () => virtualizer.isAtEnd(),
      toEnd: () => virtualizer.scrollToEnd({ behavior: 'smooth' }),
      toRow: (row) => virtualizer.scrollToIndex(row, { align: 'start', behavior: 'smooth' }),
    }),
    [virtualizer],
  )

  const { atLatest, reveal, revealing, sample, travel, watch } = useScrollAuthority(commands)

  /* 打开一条对话就落在最新那一端：一条对话一个盒子，所以挂载那一次就是那一次。 */
  useLayoutEffect(() => {
    if (viewport !== null) {
      virtualizer.scrollToEnd()
    }
  }, [viewport, virtualizer])

  /*
   * 一行长高超过一屏，就把上一帧铺着的行钉住这一帧。
   *
   * 必须在算区间之前定下来：区间是紧接着这一次算的，晚一帧钉等于让人先看见那一下露白。
   * 上一帧铺着的行就是人此刻正在看的行。下一帧不再跳变，判据自己不成立，钉子跟着松开 ——
   * 所以不需要定时器去撤，也不会有钉住不放的状态。
   */
  const total = virtualizer.getTotalSize()
  const before = measured.current

  measured.current = total

  pinned.current =
    before !== 0 && viewHeight.current > 0 && Math.abs(total - before) > viewHeight.current
      ? spansRef.current.map((span) => span.index)
      : []

  const items = virtualizer.getVirtualItems()

  useLayoutEffect(() => {
    spansRef.current = items
  }, [items])

  /* 走的时候把量表留下：下次打开这条对话，首帧的总高就是这一份。 */
  useLayoutEffect(
    () => () => {
      keepMeasurements(conversation, virtualizer.takeSnapshot())
    },
    [conversation, virtualizer],
  )

  /* 两帧之后几何稳了，把预留抬到能盖住一次快滚的量。 */
  useLayoutEffect(() => {
    const view = viewport?.ownerDocument.defaultView ?? null

    if (view === null) {
      return
    }

    let second = 0

    const first = view.requestAnimationFrame(() => {
      second = view.requestAnimationFrame(() => {
        setOverscan(OVERSCAN_SETTLED)
      })
    })

    return () => {
      view.cancelAnimationFrame(first)
      view.cancelAnimationFrame(second)
    }
  }, [viewport])

  /*
   * 一个滚动区，一处装卸：监听、意图、尺寸通知同寿。
   *
   * 原生 scroll 不冒泡，所以监听挂在元素上而不写成 onScroll —— 后者会被任何一个后代
   * 滚动容器叫醒。视线所在的行一帧读一次：一次滚轮派发几十个事件，读的是同一份布局。
   *
   * 尺寸变化走 ResizeObserver：流式输出撑高行、面板被拖窄、抽屉展开都改几何而不产生
   * 滚动事件，它还一并覆盖不经过 React 的那些（图片解码、字体换页）。
   */
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

        viewHeight.current = viewport.clientHeight

        const spans = spansRef.current
        const reading = rowAtAnchor(
          spans,
          viewport.scrollTop + viewport.clientHeight * READING_ANCHOR_RATIO,
        )

        if (reading !== null) {
          setReadingRow(reading.index)
        }

        /* 末端判据归虚拟器，这里只在同一次布局读取里采样。 */
        sample()

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
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.target === viewport && transcriptRef.current !== null) {
          setScrollMargin(transcriptRef.current.offsetTop)
        }

        if (entry.target === tailRef.current) {
          const [box] = entry.borderBoxSize

          if (box !== undefined) {
            setTailSize(box.blockSize)
          }
        }
      }

      sync()
    })

    observer.observe(viewport)

    if (transcriptRef.current !== null) {
      observer.observe(transcriptRef.current)
    }

    if (tailRef.current !== null) {
      observer.observe(tailRef.current, { box: 'border-box' })
    }

    viewport.addEventListener('scroll', sync, { passive: true })

    const unwatch = watch(viewport)

    return () => {
      if (frame !== null) {
        cancelAnimationFrame(frame)
      }

      viewport.removeEventListener('scroll', sync)
      observer.disconnect()
      unwatch()
    }
  }, [sample, viewport, watch])

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
    <div className="agent-activity-feed">
      <div className="agent-activity-feed__viewport" ref={setViewport}>
        <div
          aria-busy={isBusy}
          className="agent-activity-feed__transcript"
          ref={transcriptRef}
          role="log"
          style={{ height: virtualizer.getTotalSize() }}
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
