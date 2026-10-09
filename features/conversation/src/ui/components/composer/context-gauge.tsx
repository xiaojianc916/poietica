import './context-gauge.css'

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@poietica/design-system'
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { AgentUsageBreakdown } from '../../agent/dto'
import type { SessionUsage } from '../../agent/usage'
import { useDismissOutside } from './composer-palette'

/*
 * 上下文用量胶囊：常显圆环；悬浮出提示，点开出面板。
 *
 * 圆环几何与配色照抄 DeepSeek Harness 的 ContextMeter（正本：14 视窗、r=5.5、
 * 描边 2、轨道取 border-l3、前景取 label-tertiary、前景自顶点起画），取它 2026-09-30
 * 的装机版本。唯一的本仓增量是阈值：75/90/95% 起前景换成黄橙红（沿用 ACP 建议档），
 * 正常那三档与正本一模一样。
 *
 * 面板（尺寸、留白、圆角、条高、色块、玻璃底、三段读数）同样照抄它的
 * ContextMeter.module.css 与 ContextMeter.js；配色取它那套设计平台的静态色。
 *
 * 行比正本多：正本只画三行，omp 自己报的构成有七格（五类占用 + 空闲 + 自动压缩缓冲）。
 * 多出来的行沿用正本那条规矩 —— 每段的宽度按窗口摊开，所以彩色那一段正好等于读数，
 * 其余是底色，看着与正本同一条。
 */

/* 与正本同一条：14 视窗里 r=5.5、描边 2（描边写在 CSS，不写属性）。 */
const RADIUS = 5.5
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

const PERCENT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1, style: 'percent' })

/* 与触发器隔开 8、离窗口边 12：正本 useAnchoredPosition 的 gap 与 margin。 */
const GAP = 8
const MARGIN = 12

/*
 * 行序即条上分段的顺序，与 omp 自己的 /context 面板同序：五类占用在前，
 * 空闲与自动压缩缓冲在后。`tint` 只决定颜色，见 context-gauge.css。
 */
const ROWS = [
  { key: 'systemPrompt', label: '系统提示词', tint: 'system' },
  { key: 'systemTools', label: '工具定义', tint: 'tools' },
  { key: 'systemContext', label: '系统上下文', tint: 'context' },
  { key: 'skills', label: '技能', tint: 'skills' },
  { key: 'messages', label: '对话消息', tint: 'messages' },
  { key: 'free', label: '空闲', tint: 'free' },
  { key: 'autoCompactBuffer', label: '自动压缩缓冲', tint: 'buffer' },
] as const

/*
 * 条上只铺「已经用掉的那几类」——正本就是这么画的：段的宽度 = 读数 × 该类占比，
 * 于是彩色的总长恰好等于读数，剩下的灰条就是没用上的空间。
 *
 * 「空闲」与「自动压缩缓冲」按定义就是那段灰条，不另画成段：铺进去会让条永远满格，
 * 正本那张 2% 的图（一小点 + 一条长灰条）就再也画不出来了。
 */
const BAR_ROWS = ROWS.filter((row) => row.key !== 'free' && row.key !== 'autoCompactBuffer')

/* 三档阈值：<75% 正常，75% 起提醒，90% 起该收，95% 起下一句可能塞不下。
   沿用 ACP 会话用量规范的建议档 —— 它是这套数字的来历，不是运行时依赖。 */
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

/* 正本的紧凑计数：一千以下原样，一千以上 K，一百万以上 M；三位以上不留小数。 */
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
  /** 悬浮提示那一行用的读数，与正本同一种写法（一位小数）。 */
  readonly label: string
  /** 面板头部的整数读数，正本 Math.round 出来的那一个。 */
  readonly reading: string
  readonly used: number
  readonly size: number
  /** 条上那几段，合计就是一整个窗口。构成缺席时只有一段，宽度就是读数。 */
  readonly segments: readonly {
    readonly key: string
    readonly tint?: string
    readonly width: number
  }[]
  /**
   * 构成缺席即 undefined：那时不画行，而不是画七行 0。
   *
   * 线上那一格是 `| null`（Rust 的 Option），到了这里必须收敛成一种缺席写法 ——
   * 留两种，渲染处的判断就只能挡住其中一种。
   */
  readonly breakdown: AgentUsageBreakdown | undefined
}

/**
 * 读数与分段的推导。纯函数：屏幕上那几个数只有这一处算法。
 *
 * 段宽按正本那条算：读数 × 该类占「已用那几类之和」的比例，于是各段合计正好等于
 * 读数。条上剩下的灰就是空闲，与正本那张图的观感一致。
 */
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

/* 与正本逐属性同形：14×14 视窗、圆心 7、描边写在 CSS、前景用 dasharray 自顶点起画。 */
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
  /** agent 最近报的用量；还没报过就整个不画。 */
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

  /* Escape 关面板，同正本。开合只有这一处状态，键盘与指针走同一条路。 */
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

  /* 面板钉在触发器上方、右缘贴齐，越界时收进窗口 —— 正本 useAnchoredPosition 同一条。
     首帧还没量到尺寸，先隐藏落在原点，量完再摆。 */
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

  /* 没有的东西不画：会话还没报过数（或这一格还是入口）时没有胶囊，
     与 git 分支、工作区那两枚 chip 同一条规矩。 */
  if (usage === undefined || usage.size <= 0) {
    return null
  }

  const { breakdown, label, reading, segments, used, size } = gaugeLayout(usage)
  const fraction = Math.min(Math.max(usage.used / usage.size, 0), 1)

  return (
    <span className="context-gauge" ref={rootRef}>
      <TooltipProvider delay={200}>
        {/* 悬浮卡是原来那一格，原样留着；点开面板是另一件事，两者不互相取代。
            面板开着时提示让位，免得两块浮层叠在一起。 */}
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
