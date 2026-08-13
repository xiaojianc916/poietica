import './context-gauge.css'

import type { SessionUsage } from '@poietica/agent-contract'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@poietica/ui'
import { memo } from 'react'

/*
 * 上下文用量胶囊：圆环进度 + 百分比常显，悬浮展开明细卡。
 *
 * 数字全部来自 agent 的 ACP usage_update（used / size），这一层一个都不算。
 * 协议里没有的不画：输入/输出/缓存命中属于仍在草案的 End-Turn Token
 * Usage RFD，Kimi 也不报 —— 画上去只能是编的。剩余量与百分比是规范明说客户
 * 端该自己推导的两个数（remaining = size - used），阈值配色照它建议的
 * 75% / 90% / 95% 三档。
 *
 * 圆环几何借自 vercel/ai-elements 的 Context 组件源码（r=10、24 视窗、描边 2、
 * 背景环 25% 透明、前景环自顶点起画），只抄做法不引包：那是 shadcn 式源码分发。
 */

const RADIUS = 10
const STROKE = 2
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

/* K/M 是单位惯例，不是 locale 文本：40K 在任何界面语言里都该是 40K。 */
const COMPACT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1, notation: 'compact' })
const PERCENT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1, style: 'percent' })

/* 明细行用精确数：卡片就是为看清楚数而存在的，头行才用紧凑格式。 */
const EXACT = new Intl.NumberFormat('en-US')

/* ACP 会话用量规范给客户端的建议阈值：<75% 正常，75% 起提醒，90% 起该收，
   95% 起下一句可能塞不下。数值随规范走，不随观感调。 */
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

function Ring({ fraction }: { readonly fraction: number }) {
  return (
    <svg aria-hidden="true" className="context-gauge__ring" viewBox="0 0 24 24">
      <circle
        className="context-gauge__ring-track"
        cx="12"
        cy="12"
        fill="none"
        r={RADIUS}
        strokeWidth={STROKE}
      />
      <circle
        className="context-gauge__ring-fill"
        cx="12"
        cy="12"
        fill="none"
        r={RADIUS}
        strokeDasharray={CIRCUMFERENCE}
        strokeDashoffset={CIRCUMFERENCE * (1 - fraction)}
        strokeLinecap="round"
        strokeWidth={STROKE}
        transform="rotate(-90 12 12)"
      />
    </svg>
  )
}

export interface ContextGaugeProps {
  /** agent 最近报的用量；还没报过就整个不画。 */
  readonly usage?: SessionUsage | undefined
}

export const ContextGauge = memo(function ContextGauge({ usage }: ContextGaugeProps) {
  /* 没有的东西不画：会话还没报过数（或这一格还是入口）时没有胶囊，
     与 git 分支、工作区那两枚 chip 同一条规矩。 */
  if (usage === undefined || usage.size <= 0) {
    return null
  }

  const fraction = Math.min(Math.max(usage.used / usage.size, 0), 1)
  const percent = PERCENT.format(fraction)
  const level = levelOf(fraction)

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger
          aria-label={`上下文已用 ${percent}`}
          className="context-gauge__trigger"
          data-level={level}
          type="button"
        >
          <span className="context-gauge__percent">{percent}</span>
          <Ring fraction={fraction} />
        </TooltipTrigger>

        <TooltipContent className="context-gauge__card" side="top" sideOffset={8}>
          <div className="context-gauge__row">
            <span className="context-gauge__label">{percent}</span>
            <span className="context-gauge__value">
              {COMPACT.format(usage.used)} / {COMPACT.format(usage.size)}
            </span>
          </div>

          <div className="context-gauge__bar">
            <div
              className="context-gauge__bar-fill"
              data-level={level}
              style={{ width: `${String(fraction * 100)}%` }}
            />
          </div>

          <div className="context-gauge__row context-gauge__row--detail">
            <span className="context-gauge__label">已用</span>
            <span className="context-gauge__value">{EXACT.format(usage.used)}</span>
          </div>

          <div className="context-gauge__row context-gauge__row--detail">
            <span className="context-gauge__label">剩余</span>
            <span className="context-gauge__value">{EXACT.format(usage.size - usage.used)}</span>
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
})
