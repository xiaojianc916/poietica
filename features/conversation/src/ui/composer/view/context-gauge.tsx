import './context-gauge.css'

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@poietica/design-system'
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { AgentUsageBreakdown } from '../../shared/model/dto'
import type { SessionUsage } from '../../shared/model/usage'
import { useDismissOutside } from './composer-palette'

/* 上下文用量胶囊：常显圆环，悬浮出提示，点开出面板。圆环与面板几何照抄上游 ContextMeter（14 视窗、r=5.5、描边 2），本仓多了 75/90/95 三档阈值。 */

const RADIUS = 5.5
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

const PERCENT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1, style: 'percent' })

/* 隔开 8、离窗口边 12：上游 useAnchoredPosition 的 gap 与 margin。 */
const GAP = 8
const MARGIN = 12

/* 行序即条上分段顺序，与 omp 自己的 /context 面板同序：五类占用在前，空闲与压缩缓冲在后。 */
const ROWS = [
  { key: 'systemPrompt', label: '系统提示词', tint: 'system' },
  { key: 'systemTools', label: '工具定义', tint: 'tools' },
  { key: 'systemContext', label: '系统上下文', tint: 'context' },
  { key: 'skills', label: '技能', tint: 'skills' },
  { key: 'messages', label: '对话消息', tint: 'messages' },
  { key: 'free', label: '空闲', tint: 'free' },
  { key: 'autoCompactBuffer', label: '自动压缩缓冲', tint: 'buffer' },
] as const

/* 条上只铺「已用掉的那几类」：段宽 = 读数 × 该类占比，彩色总长恰好等于读数，剩下的灰就是没用上的空间。
   「空闲」与「自动压缩缓冲」按定义就是那段灰条，铺进去条会永远满格，上游那张 2% 的图就再也画不出来。 */
const BAR_ROWS = ROWS.filter((row) => row.key !== 'free' && row.key !== 'autoCompactBuffer')

/* 75/90/95 起依次提醒、该收、下一句可能塞不下；数字来自 ACP 会话用量规范的建议档。 */
function levelOf(fraction: number): 'ok' | 'warn' | 'high' | 'critical' {
  if (fraction >= 0.95) {
    return 'critical'
  }
  if (fraction >= 0.9) {
    return 'high'
  }
  if (fraction >= 0.75) {
    return 'warn'
  }
  return 'ok'
}

export function formatTokens(value: number): string {
  const scaled = (candidate: number) =>
    candidate >= 100 ? String(Math.round(candidate)) : String(Math.round(candidate * 10) / 10)

  if (value < 1_000) {
    return String(value)
  }
  if (value < 1_000_000) {
    return `${scaled(value / 1_000)}K`
  }
  return `${scaled(value / 1_000_000)}M`
}

export interface GaugeLayout {
  readonly label: string
  readonly reading: string
  readonly used: number
  readonly size: number
  readonly segments: readonly {
    readonly key: string
    readonly tint?: string
    readonly width: number
  }[]
  /** 构成缺席即 undefined：线上那格是 Rust 的 Option | null，两种缺席写法只留一种。 */
  readonly breakdown: AgentUsageBreakdown | undefined
}

/** 屏幕上那几个数只有这一处算法：段宽 = 读数 × 该类占「已用那几类之和」的比例，各段合计正好等于读数。 */
export function gaugeLayout(usage: SessionUsage): GaugeLayout {
  const fraction = Math.min(Math.max(usage.used / usage.size, 0), 1)
  const percent = Math.round(fraction * 100)
  const breakdown = usage.breakdown ?? undefined
  const total =
    breakdown === undefined
      ? 0
      : breakdown.systemPrompt + breakdown.systemTools + breakdown.systemContext + breakdown.skills + breakdown.messages

  return {
    breakdown,
    label: PERCENT.format(fraction),
    reading: `${percent}%`,
    used: usage.used,
    size: usage.size,
    segments:
      breakdown === undefined || total === 0
        ? [{ key: 'total', width: percent }]
        : BAR_ROWS.map((row) => ({
            key: row.key,
            tint: row.tint,
            width: (percent * breakdown[row.key]) / total,
          })).filter((segment) => segment.width > 0),
  }
}

function Ring({ fraction }: { readonly fraction: number }) {
  return (
    <svg aria-hidden="true" className="context-gauge__ring" height="14" viewBox="0 0 14 14" width="14">
      <circle className="context-gauge__ring-track" cx="7" cy="7" r={RADIUS} />

      <circle
        className="context-gauge__ring-fill"
        cx="7"
        cy="7"
        r={RADIUS}
        strokeDasharray={`${CIRCUMFERENCE * fraction} ${CIRCUMFERENCE}`}
        transform="rotate(-90 7 7)"
      />
    </svg>
  )
}

export interface ContextGaugeProps {
  readonly usage?: SessionUsage | undefined
}

export const ContextGauge = memo(function ContextGauge({ usage }: ContextGaugeProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLSpanElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)

  const close = useCallback(() => {
    setOpen(false)
  }, [])

  /* 面板经传送门落在 body 下，所以把它那一格也交给判据：点面板内部不算「点外面」。 */
  useDismissOutside(open, rootRef, close, panelRef)

  useEffect(() => {
    if (!open) {
      return undefined
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        close()
      }
    }

    document.addEventListener('keydown', onKeyDown)

    return () => {
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [close, open])

  /* 面板钉在触发器上方、右缘贴齐，越界收进窗口；首帧还没量到尺寸，先隐藏落在原点。 */
  useLayoutEffect(() => {
    if (!open) {
      setPosition(null)

      return undefined
    }

    const place = () => {
      const anchor = rootRef.current?.getBoundingClientRect()
      const panel = panelRef.current

      if (anchor === undefined || panel === null) {
        return
      }

      const width = panel.offsetWidth
      const height = panel.offsetHeight

      setPosition({
        left: Math.min(Math.max(anchor.right - width, MARGIN), window.innerWidth - width - MARGIN),
        top: Math.min(Math.max(anchor.top - GAP - height, MARGIN), window.innerHeight - height - MARGIN),
      })
    }

    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)

    const panel = panelRef.current
    const observer = typeof ResizeObserver === 'undefined' || panel === null ? null : new ResizeObserver(place)

    if (panel !== null) {
      observer?.observe(panel)
    }

    return () => {
      observer?.disconnect()
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [open])

  /* 会话还没报过数（或这一格还是入口）就不画胶囊，与 git 分支、工作区那两枚 chip 同一条规矩。 */
  if (usage === undefined || usage.size <= 0) {
    return null
  }

  const { breakdown, label, reading, segments, used, size } = gaugeLayout(usage)
  const fraction = Math.min(Math.max(usage.used / usage.size, 0), 1)

  return (
    <span className="context-gauge" ref={rootRef}>
      <TooltipProvider delay={200}>
        {/* 悬浮卡与点开的面板是两件事，不互相取代；面板开着时提示让位，免得两块浮层叠在一起。 */}
        <Tooltip disabled={open}>
          <TooltipTrigger
            aria-expanded={open}
            aria-haspopup="dialog"
            aria-label={`上下文已用 ${label}`}
            className="context-gauge__trigger"
            data-level={levelOf(fraction)}
            onClick={() => {
              setOpen(!open)
            }}
            type="button"
          >
            <Ring fraction={fraction} />
          </TooltipTrigger>

          <TooltipContent className="context-gauge__card" side="top" sideOffset={8}>
            <span className="context-gauge__card-text">上下文已用 {label}</span>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>

      {open
        ? createPortal(
            <div
              aria-label="上下文已用"
              className="context-gauge__panel"
              ref={panelRef}
              role="dialog"
              style={position ?? { left: 0, top: 0, visibility: 'hidden' }}
            >
              <div className="context-gauge__header">
                <span className="context-gauge__headline">上下文已用</span>
                <span className="context-gauge__percent">{reading}</span>
                <span className="context-gauge__figures">
                  ~{formatTokens(used)} / {formatTokens(size)}
                </span>
              </div>

              <div className="context-gauge__bar">
                {segments.map((segment) => (
                  <div
                    className={
                      segment.tint === undefined
                        ? 'context-gauge__segment'
                        : `context-gauge__segment context-gauge__segment--${segment.tint}`
                    }
                    key={segment.key}
                    style={{ width: `${segment.width}%` }}
                  />
                ))}
              </div>

              {breakdown === undefined ? null : (
                <dl className="context-gauge__rows">
                  {ROWS.map((row) => (
                    <div className="context-gauge__row" key={row.key}>
                      <dt>
                        <span
                          aria-hidden="true"
                          className={`context-gauge__swatch context-gauge__swatch--${row.tint}`}
                        />
                        {row.label}
                      </dt>
                      <dd>~{formatTokens(breakdown[row.key])}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </div>,
            document.body,
          )
        : null}
    </span>
  )
})
