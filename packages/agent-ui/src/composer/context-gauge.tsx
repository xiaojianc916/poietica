import './context-gauge.css'

import type { SessionUsage } from '@poietica/agent-contract'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@poietica/ui'
import { memo } from 'react'

/*
 * 上下文用量胶囊：圆环进度 + 百分比常显，悬浮展开明细卡。
 *
 * 数字全部来自 agent 的 ACP usage_update（used / size / cost?），这一层一个都
 * 不算：token 只有引擎自己数得准，Codex 的 /status、Claude Code 的 context
 * 指示、Zed 的 ACP 面板都以 agent 报数为准。Kimi 从不报 cost，所以费用那一行
 * 只在真的报了时才画 —— 缺一格就少画一格，不编造。
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

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger
          aria-label={'上下文已用 ' + percent}
          className="context-gauge__trigger"
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
              style={{ width: String(fraction * 100) + '%' }}
            />
          </div>

          {usage.cost === undefined ? null : (
            <div className="context-gauge__cost">
              <span className="context-gauge__label">Total cost</span>
              <span className="context-gauge__value">
                {new Intl.NumberFormat('en-US', {
                  currency: usage.cost.currency,
                  style: 'currency',
                }).format(usage.cost.amount)}
              </span>
            </div>
          )}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
})
