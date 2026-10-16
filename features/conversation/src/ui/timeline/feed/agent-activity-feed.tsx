import './agent-activity-feed.css'

import { defaultRangeExtractor, type Range, useVirtualizer, type VirtualItem } from '@tanstack/react-virtual'
import { type CSSProperties, type ReactNode, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ToLatestIcon } from '../../shared/primitives/icons'
import { useDevicePixels } from '../../shared/primitives/use-device-pixels'
import type { Presentation } from '../presentation'
import { geometryOf, keepGeometry } from './conversation-geometry'
import { KeepAlive, mergeRange } from './keep-alive'
import { rowAtAnchor } from './reading-position'
import { useScrollAuthority } from './scroll-authority'

/* 两级而非折中值：首帧行高多是估的，铺多了白测；几何稳了再抬到盖得住一次快滚。 */
const OVERSCAN_COLD = 6
const OVERSCAN_SETTLED = 20

const KEEP_ALIVE_ROWS = 80

/** 取 1/3 而非上沿：上沿会被上一轮残留的一个像素占住。 */
const READING_ANCHOR_RATIO = 1 / 3

/** 触顶才取会看见一次停顿，所以提前这么多屏去要更早的一页。 */
const EARLIER_LEAD_SCREENS = 1

/** 一格滚轮的量：不足它就算在末端。 */
const END_THRESHOLD_PX = 48

export interface FeedPort {
  readonly activeRow: number
  readonly scrollToRow: (index: number) => void
}

/** 只有两种行距：glyph（左图标右文字的记事）与 prose（正文）。 */
export type RowRhythm = 'glyph' | 'prose'

export interface AgentActivityFeedProps {
  readonly conversation: string
  readonly feed: Presentation
  /** 封条与抽屉的开合表。换身份＝长高是人点出来的，虚拟器把量补进 scrollTop 钉底边。 */
  readonly disclosed: object
  readonly estimateRow: (index: number) => number
  readonly rowRhythm: (index: number) => RowRhythm
  readonly renderRow: (index: number) => ReactNode
  readonly isBusy: boolean
  /** null 表示首帧布局尚未落定。 */
  readonly dockClearance: number | null
  readonly hasEarlier: boolean
  readonly onReachStart: () => Promise<void>
  readonly lead?: ReactNode
  readonly overlay?: (port: FeedPort) => ReactNode
  /** 转录末尾那一格（运行状态行）。它不在虚拟列表里：那一行每秒都在改字，参与测量就是一次滚动补偿。 */
  readonly trailing?: ReactNode
}

/** 位置归虚拟器，意图归 scroll-authority，这里一个 scrollTop 都不写。 */
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
  trailing,
}: AgentActivityFeedProps) {
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null)
  const transcriptRef = useRef<HTMLDivElement | null>(null)
  const leadRef = useRef<HTMLDivElement | null>(null)

  /* 落点要踩在设备像素上：落在半个设备像素，行内 1px 的边会摊到两行、墨色减半。 */
  const snapToDevicePixels = useDevicePixels()

  /* 是 state 非 ref：虚拟器渲染期就要读它。 */
  const [scrollMargin, setScrollMargin] = useState<number | null>(null)

  /** null 是「还没读到过」，不是第 0 行。 */
  const [readingRow, setReadingRow] = useState<number | null>(null)

  const spansRef = useRef<readonly VirtualItem[]>([])
  const earlierRequest = useRef<Promise<void> | null>(null)

  const earlier = useRef({ hasEarlier, onReachStart })

  useLayoutEffect(() => {
    earlier.current = { hasEarlier, onReachStart }
  }, [hasEarlier, onReachStart])

  const rowAccess = useRef({ estimateRow, feed })
  rowAccess.current = { estimateRow, feed }
  const getItemKey = useCallback((index: number) => rowAccess.current.feed.rowAt(index)?.item.id ?? index, [])
  const estimateItem = useCallback((index: number) => rowAccess.current.estimateRow(index), [])

  /* 一条对话一份常驻集合：外层按对话号给了 key，换对话整个组件换掉。 */
  const [keepAlive] = useState(() => new KeepAlive(KEEP_ALIVE_ROWS))

  /* 渲染集合 = 默认区间 ∪ 常驻行：常驻行在视口之外，测量成本不涨；下标要从 key 换回来 —— 续读会在前面插行。 */
  const extractRange = useCallback(
    (range: Range) => {
      const base = defaultRangeExtractor(range)
      const current = rowAccess.current.feed
      const keyAt = (index: number) => current.rowAt(index)?.item.id ?? index

      keepAlive.touch(base.map(keyAt))

      return mergeRange(base, keepAlive.keys(), (id) => current.rowOf(id), range.count)
    },
    [keepAlive],
  )

  const [restored] = useState(() => geometryOf(conversation))

  const settled = scrollMargin !== null && dockClearance !== null

  /* 人点开抽屉那一帧末端锚定让位给起始锚定：要钉的是被点的那一行。 */
  const [held, setHeld] = useState(disclosed)
  const holding = held !== disclosed
  const measuredTotal = useRef(0)

  const { atLatest, pinned, reveal, revealing, sample, travel, watch } = useScrollAuthority(restored?.reading ?? null)

  /* 这些令牌注册为 length，getComputedStyle 因而返回可直接相加的像素值。 */
  const metrics = useMemo(() => {
    if (viewport === null) {
      return { dissolve: 0, gap: 0, glyph: 0, prose: 0 }
    }

    const style = getComputedStyle(viewport)
    const read = (token: string) => Number.parseFloat(style.getPropertyValue(token)) || 0

    return {
      dissolve: read('--cp-dock-dissolve'),
      gap: read('--cp-dock-gap'),
      glyph: read('--cp-feed-glyph-row-gap'),
      prose: read('--cp-feed-prose-row-gap'),
    }
  }, [viewport])

  const leadOf = (row: number) => metrics[rowRhythm(row)]
  /* 运行行在时留它的跑道；不在时只留净空 —— 静止态下整条跑道会读成悬空的一截。 */
  const runway = trailing === undefined ? metrics.gap : metrics.dissolve
  const paddingEnd = dockClearance === null ? 0 : dockClearance + runway

  const virtualizer = useVirtualizer({
    /* 落点 = item.start - scrollPaddingStart：被揭示的行之上留一格行距。 */
    scrollPaddingStart: revealing === null ? 0 : leadOf(revealing),
    count: feed.count,
    getScrollElement: () => viewport,
    estimateSize: estimateItem,
    getItemKey,
    /* 交出副本：这份会被虚拟器收走当自己的初值。 */
    initialMeasurementsCache: restored === undefined ? [] : [...restored.rows],
    scrollMargin: scrollMargin ?? 0,
    paddingEnd,
    overscan: settled ? OVERSCAN_SETTLED : OVERSCAN_COLD,
    rangeExtractor: extractRange,
    anchorTo: holding ? 'start' : 'end',
    followOnAppend: !holding,
    scrollEndThreshold: END_THRESHOLD_PX,
    /* 渲染器只有 Chromium，原生 scrollend 已可用。 */
    useScrollendEvent: true,
  })

  /* 长高的量只补视口之上那些行。这一格是 virtual-core 的实例字段，传进选项表会被静默忽略。 */
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) =>
    item.start + leadOf(item.index) < (instance.scrollOffset ?? 0)

  const total = virtualizer.getTotalSize()

  /* 挂载首钉落在还没量到的假末端上，所以落末端只能是一份持续意图，坐标一动就重钉一次。 */
  const end = (scrollMargin ?? 0) + total

  const intent = revealing === null ? (pinned ? `end:${String(end)}` : null) : `row:${String(revealing)}:${String(end)}`
  const wroteAt = useRef<string | null>(null)

  useLayoutEffect(() => {
    if (intent === null) {
      /* 意图撤了也要清空：同一行再点一次仍要写一次位置。 */
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

    virtualizer.scrollToIndex(revealing, { align: 'start' })
  }, [intent, revealing, settled, viewport, virtualizer])

  /* 让位只覆盖人点出来的那一次测量：量到了就当场归位。 */
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

  const seen = useRef<{ pinned: boolean; reading: number | null }>({
    pinned: true,
    reading: null,
  })

  useLayoutEffect(() => {
    seen.current = { pinned, reading: readingRow }
  }, [pinned, readingRow])

  useLayoutEffect(
    () => () => {
      keepGeometry(conversation, {
        rows: virtualizer.takeSnapshot(),
        /* 在末端就不记行号：回来时继续跟随末端。 */
        reading: seen.current.pinned ? null : seen.current.reading,
      })
    },
    [conversation, virtualizer],
  )

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
        /* 常驻行远在上方或下方，不影响这次二分。 */
        const reading = rowAtAnchor(spans, viewport.scrollTop + viewport.clientHeight * READING_ANCHOR_RATIO)

        if (reading !== null) {
          setReadingRow(reading.index)
        }

        /* 末端判据归虚拟器，这里只在同一次布局读取里采样。 */
        sample(virtualizer.isAtEnd())

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

    /* 尾部必须按边框盒观察：它的高度整个来自 padding-block-end，content-box 不派发。 */
    const observer = new ResizeObserver(() => {
      if (transcriptRef.current !== null) {
        setScrollMargin(transcriptRef.current.offsetTop)
      }

      sync()
    })

    observer.observe(viewport)

    if (transcriptRef.current !== null) {
      const transcript = transcriptRef.current

      /* 首次通知晚于首帧，挂载时先同步读一次。 */
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

  /* 自己说的话把视线带回末端：触发者是数据 —— 最后一条我说的话换了 id。换对话走挂载那一路，不算。 */
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

  const activeRow = revealing ?? readingRow ?? Math.max(0, feed.count - 1)

  return (
    <div
      className="agent-activity-feed"
      style={
        {
          '--cp-dock-clearance': `${String(dockClearance ?? 0)}px`,
          '--cp-dock-runway': `${String(runway)}px`,
        } as CSSProperties
      }
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
          {/* 位置只有一个来源：虚拟器算出来的 start。 */}
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

          {/*
            转录的最后一格（运行状态行）。它落在**末尾那段留白里** —— 虚拟器为输入框预留的
            paddingEnd 正是这一段，把这一格摆在留白的上沿，它就正好压在最后一条消息下面、
            输入框上面；摆到转录盒外面则会掉进输入框底下（那一段留白是给输入框让位的）。
            它不进行测量：这一格每秒都在改字，量它等于每秒一次滚动补偿。
          */}
          {trailing === undefined ? null : (
            <div className="agent-activity-feed__trailing" style={{ insetBlockStart: total - paddingEnd }}>
              {trailing}
            </div>
          )}
        </div>
      </div>

      {/* 常驻挂载，靠 data-shown 在静态状态间过渡；隐藏时挂 inert —— opacity 0 的按钮仍可点、仍进 Tab 序。判据是 atLatest 而非 isBusy。 */}
      <button
        aria-label="回到最新"
        className="agent-activity-feed__to-latest"
        data-shown={atLatest ? undefined : 'true'}
        inert={atLatest}
        onClick={travel}
        type="button"
      >
        <ToLatestIcon aria-hidden="true" />
      </button>

      {overlay === undefined ? null : overlay({ activeRow, scrollToRow: reveal })}
    </div>
  )
}
