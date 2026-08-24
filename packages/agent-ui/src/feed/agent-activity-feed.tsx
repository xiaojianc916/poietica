import './agent-activity-feed.css'

import type { Presentation } from '@poietica/agent'
import { useVirtualizer, type VirtualItem } from '@tanstack/react-virtual'
import { type ReactNode, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ChevronDownIcon } from '../primitives/icons'
import { useDevicePixels } from '../primitives/use-device-pixels'
import { rowAtAnchor } from './reading-position'
import { reuseRowKeys } from './row-keys'
import { type RowGeometry, useScrollAuthority } from './scroll-authority'

/** 视口之外预留的行数。会话行远高于表格行：少了快滚露白，多了白测量。 */
const OVERSCAN_ROWS = 6

/**
 * 视线在视口里的位置，自上而下的比例。
 *
 * 上沿是一条边，上一轮的残留一个像素就占住它；三分之一处是人真正在看的地方。
 */
const READING_ANCHOR_RATIO = 1 / 3

/** 距顶端不足这么多屏就去要更早的一页：触顶才取，看见的就是一次停顿。 */
const EARLIER_LEAD_SCREENS = 1

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
   * 滚动位置是这个盒子的状态，而盒子跨对话复用。「换了一条对话」与「同一条里又多一句」
   * 是两件事，转录内容分不出它们，所以身份由持有它的那一层交下来。
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
 * 它铺内容、量几何，一个 scrollTop 都不写：位置归 scroll-authority。虚拟器只算位置，
 * 浏览器原生的滚动锚定在样式里关掉，于是「谁决定视口在哪」全仓只有一个答案。
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

  const { atLatest, revealing, reveal, resume, settle, travel, watch } = useScrollAuthority()

  /** 虚拟器此刻铺出来的区间表，给那两次二分用。提交之后镜像一次。 */
  const spansRef = useRef<readonly VirtualItem[]>([])
  const earlierRequest = useRef<Promise<void> | null>(null)

  /**
   * 行身份表。序列没变就是同一个引用，于是 getItemKey 的身份也不变 —— 虚拟器的
   * measurements 备忘把它算进依赖，换一次就整表从 0 重建。
   *
   * 用渲染期比对而不是一份 ref 镜像：这是官方给「从上一次渲染带一点信息过来」的形状，
   * 纯函数、StrictMode 下跑两遍答案相同。
   */
  const [keyed, setKeyed] = useState<{
    readonly feed: Presentation
    readonly keys: readonly string[]
  }>(() => ({ feed, keys: reuseRowKeys(undefined, feed) }))

  const rowKeys = keyed.feed === feed ? keyed.keys : reuseRowKeys(keyed.keys, feed)

  if (keyed.feed !== feed) {
    setKeyed({ feed, keys: rowKeys })
  }

  /* 身份是 id 不是序号：回填历史会让每一条换序号，用序号当身份锚点就落到别的条目上。 */
  const getItemKey = useCallback((index: number) => rowKeys[index] ?? index, [rowKeys])

  const virtualizer = useVirtualizer({
    count: feed.count,
    getScrollElement: () => viewport,
    estimateSize: estimateRow,
    getItemKey,
    scrollMargin,
    paddingEnd: tailSize,
    overscan: OVERSCAN_ROWS,
    /* 滚动停没停问浏览器：库那条 isScrollingResetDelay 的退路是为跨浏览器差异准备的，
       而这里的渲染器只有 Chromium，原生 scrollend 早已可用。 */
    useScrollendEvent: true,
  })

  const items = virtualizer.getVirtualItems()

  useLayoutEffect(() => {
    spansRef.current = items
  }, [items])

  /** 行几何。行号进、像素出：持有位置的那一层因此不认识虚拟器。 */
  const rows = useMemo<RowGeometry>(
    () => ({
      offsetOf: (key) => {
        const index = feed.indexOf(key)

        return index < 0 ? null : (virtualizer.getOffsetForIndex(index, 'start')?.[0] ?? null)
      },
      offsetOfRow: (row) => virtualizer.getOffsetForIndex(row, 'start')?.[0] ?? null,
      top: () => {
        if (viewport === null) {
          return null
        }

        const found = rowAtAnchor(spansRef.current, viewport.scrollTop)

        return found === null || typeof found.key !== 'string'
          ? null
          : { key: found.key, offset: found.start - viewport.scrollTop }
      },
    }),
    [feed, viewport, virtualizer],
  )

  /*
   * 每次提交把几何交出去一次，位置的写入全部发生在那一层。
   *
   * 这里不判「内容长高了没有」：水位线分不出「末尾追加」与「向上补了一页」，而后者
   * 恰恰不该把视口带走 —— 那正是往上滑被拽回末端的成因。
   *
   * 更早那一页在同一处要：虚拟窗口每次变化都是一次提交，所以这一问的时机与滚动对齐，
   * 而先导量仍是一屏。
   */
  useLayoutEffect(() => {
    settle(rows)

    if (
      viewport === null ||
      !hasEarlier ||
      earlierRequest.current !== null ||
      viewport.scrollTop >= viewport.clientHeight * EARLIER_LEAD_SCREENS
    ) {
      return
    }

    const request = Promise.resolve().then(onReachStart)

    earlierRequest.current = request
    void request.finally(() => {
      if (earlierRequest.current === request) {
        earlierRequest.current = null
      }
    })
  })

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

        const reading = rowAtAnchor(
          spansRef.current,
          viewport.scrollTop + viewport.clientHeight * READING_ANCHOR_RATIO,
        )

        if (reading !== null) {
          setReadingRow(reading.index)
        }
      })
    }

    /*
     * 转录也在名单上：它盖住行内的异步排版与抽屉展开。回路接不上，因为回调里两句都写
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
  }, [viewport, watch])

  /*
   * 自己说的话把视线带回末端：那是答复将要出现的地方。
   *
   * 触发者是数据 —— 最后一条我说的话换了 id。判据必须带上对话身份，否则换一条对话时
   * 「最后一条我说的话」也换了 id，会被判成「我又说了一句」而走一段带缓动的位移。
   */
  const ownMessage = feed.latestOwnMessage
  const said = useRef<{ readonly conversation: string; readonly message: string | null } | null>(
    null,
  )

  useLayoutEffect(() => {
    const before = said.current

    said.current = { conversation, message: ownMessage }

    if (before === null || before.conversation !== conversation) {
      resume()

      return
    }

    if (before.message === null || ownMessage === null || before.message === ownMessage) {
      return
    }

    travel()
  }, [conversation, ownMessage, resume, travel])

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
