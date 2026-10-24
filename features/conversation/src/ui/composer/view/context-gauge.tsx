import './context-gauge.css'

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger, useOverlayRef } from '@poietica/design-system'
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { AgentSessionTokens, AgentUsageBreakdown } from '../../shared/model/dto'
import { formatTokens, type SessionUsage } from '../../shared/model/usage'
import { useDismissOutside } from './composer-palette'

/* 上下文用量胶囊：常显圆环，悬浮出提示，点开出面板。圆环与面板几何照抄上游 ContextMeter（14 视窗、r=5.5、描边 2），本仓多了 75/90/95 三档阈值。 */

const RADIUS = 5.5
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

const PERCENT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1, style: 'percent' })

/* 隔开 8、离窗口边 12：上游 useAnchoredPosition 的 gap 与 margin。 */
const GAP = 8
const MARGIN = 12

/* 行序即条上分段顺序，与 omp 自己的 /context 面板同序。条上只铺这五类：段宽 = 读数 × 该类占比，
   彩色总长恰好等于读数，剩下的灰就是没用上的空间。 */
const ROWS = [
  { key: 'systemPrompt', label: '系统提示词', tint: 'system' },
  { key: 'systemTools', label: '工具定义', tint: 'tools' },
  { key: 'systemContext', label: '系统上下文', tint: 'context' },
  { key: 'skills', label: '技能', tint: 'skills' },
  { key: 'messages', label: '对话消息', tint: 'messages' },
] as const

/**
 * 缓存命中率 = cacheRead ÷（input + cacheRead + cacheWrite）。分母是 omp 自己的「这次请求的提示词」口径
 * （pi-agent-core 的 calculatePromptTokens）：pi-ai 的 input 已经扣掉了命中缓存的那部分，三格相加才是送进模型的全部输入。
 * 还没有任何输入（新会话）时没有比率可言，交 null，屏幕画「—」而不是 0%。
 */
export function cacheHitRate(tokens: AgentSessionTokens): number | null {
  const prompt = tokens.input + tokens.cacheRead + tokens.cacheWrite
  return prompt > 0 ? tokens.cacheRead / prompt : null
}

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
  /** 会话用量两行（缓存命中率、token 消耗）的成品文字；会话用量缺席即 undefined，两行都不画。 */
  readonly session:
    | {
        readonly cacheHitRate: string
        readonly tokensSpent: string
      }
    | undefined
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

  const tokens = usage.tokens ?? undefined
  const rate = tokens === undefined ? null : cacheHitRate(tokens)

  return {
    breakdown,
    session:
      tokens === undefined
        ? undefined
        : {
            cacheHitRate: rate === null ? '—' : PERCENT.format(rate),
            tokensSpent: `~${formatTokens(tokens.total)}`,
          },
    label: PERCENT.format(fraction),
    reading: `${percent}%`,
    used: usage.used,
    size: usage.size,
    segments:
      breakdown === undefined || total === 0
        ? [{ key: 'total', width: percent }]
        : ROWS.map((row) => ({
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

/* 面板的明细：五行构成（有构成才画）+ 两行会话用量（有用量才画），两块都缺就整块不画。 */
function GaugeRows({ breakdown, session }: Pick<GaugeLayout, 'breakdown' | 'session'>) {
  if (breakdown === undefined && session === undefined) {
    return null
  }

  return (
    <dl className="context-gauge__rows">
      {breakdown === undefined
        ? null
        : ROWS.map((row) => (
            <GaugeRow key={row.key} label={row.label} tint={row.tint} value={`~${formatTokens(breakdown[row.key])}`} />
          ))}
      {/* 原「空闲 / 自动压缩缓冲」两行的位置与色块：数换成 omp 的会话用量累计 */}
      {session === undefined ? null : (
        <>
          <GaugeRow label="缓存命中率" tint="cache" value={session.cacheHitRate} />
          <GaugeRow label="token 消耗" tint="spend" value={session.tokensSpent} />
        </>
      )}
    </dl>
  )
}

function GaugeRow({ label, tint, value }: { readonly label: string; readonly tint: string; readonly value: string }) {
  return (
    <div className="context-gauge__row">
      <dt>
        <span aria-hidden="true" className={`context-gauge__swatch context-gauge__swatch--${tint}`} />
        {label}
      </dt>
      <dd>{value}</dd>
    </div>
  )
}

export interface ContextGaugeProps {
  readonly usage?: SessionUsage | undefined
  /** 从外面打开（斜杠命令 `/context`）：每变一次就打开一次面板；计数而不是布尔，开合仍归这一层 */
  readonly openRequest?: number | undefined
}

export const ContextGauge = memo(function ContextGauge({ openRequest, usage }: ContextGaugeProps) {
  const [open, setOpen] = useState(false)
  const [seenRequest, setSeenRequest] = useState(openRequest)

  /* 渲染期对比上一次的请求号（「props 变了就调 state」）；还没有读数时胶囊不画，也就不开 */
  if (seenRequest !== openRequest) {
    setSeenRequest(openRequest)
    if (openRequest !== undefined && usage !== undefined && usage.size > 0) setOpen(true)
  }
  const rootRef = useRef<HTMLSpanElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  /* 面板自己建传送门，不经 design-system 的浮层控件，所以自己登记（浏览器面板的原生视图靠它让路） */
  const panelOverlayRef = useOverlayRef('anchored', panelRef)
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

  const { breakdown, label, reading, segments, session, used, size } = gaugeLayout(usage)
  const fraction = Math.min(Math.max(usage.used / usage.size, 0), 1)

  return (
    <span className="context-gauge" data-context-gauge="" ref={rootRef}>
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

          <TooltipContent className="context-gauge__card" data-context-gauge="" side="top" sideOffset={8}>
            <span className="context-gauge__card-text">上下文已用 {label}</span>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>

      {open
        ? createPortal(
            <div
              aria-label="上下文已用"
              className="context-gauge__panel"
              data-context-gauge=""
              ref={panelOverlayRef}
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

              <GaugeRows breakdown={breakdown} session={session} />
            </div>,
            document.body,
          )
        : null}
    </span>
  )
})
