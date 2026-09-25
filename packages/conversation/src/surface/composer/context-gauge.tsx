import './context-gauge.css'

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@poietica/design-system'
import { memo } from 'react'
import type { SessionUsage } from '../../agent/usage'

/*
 * 上下文用量胶囊：只常显圆环，悬浮卡以「上下文已用 X%」一行报数。
 *
 * 数字来自 kap 的 agent.status.updated：此刻的上下文占用（used / size）。
 * 这一层只做一次除法，百分比是报数的推导。
 *
 * 圆环几何借自 vercel/ai-elements 的 Context 组件源码（r=10、24 视窗、描边 2、
 * 背景环 25% 透明、前景环自顶点起画），只抄做法不引包：那是 shadcn 式源码分发。
 */

const RADIUS = 10
const STROKE = 2
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

const PERCENT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1, style: 'percent' })

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
    <TooltipProvider delay={200}>
      <Tooltip>
        <TooltipTrigger
          aria-label={`上下文已用 ${percent}`}
          className="context-gauge__trigger"
          data-level={level}
          type="button"
        >
          <Ring fraction={fraction} />
        </TooltipTrigger>

        <TooltipContent className="context-gauge__card" side="top" sideOffset={8}>
          <span className="context-gauge__card-text">上下文已用 {percent}</span>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
})
