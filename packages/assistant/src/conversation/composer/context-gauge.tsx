import './context-gauge.css'

import type { SessionUsage } from '@poietica/conversation'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@poietica/design-system'
import { memo } from 'react'

/*
 * 上下文用量胶囊：只常显圆环，数字全部在悬浮明细卡与无障碍名里。
 *
 * 数字全部来自 kap 的 agent.status.updated：此刻的上下文占用（used / size）
 * 与会话累计的三格输入计数（usage.total，协议形状见 contracts/kap 钉住的
 * events-zod 快照）。这一层只做除法：百分比、进度条与缓存命中率都是报数的
 * 推导。协议里没有真值的不画 —— 成本在 kap 的 schema 里只有字段名，没有
 * 生产者（恒为 0），所以卡片上没有它。
 *
 * 圆环几何借自 vercel/ai-elements 的 Context 组件源码（r=10、24 视窗、描边 2、
 * 背景环 25% 透明、前景环自顶点起画），只抄做法不引包：那是 shadcn 式源码分发。
 */

const RADIUS = 10
const STROKE = 2
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

/* 分组与缩写都由 Intl 出，不手搓千分位与 K。明细那行留一位小数：3,737,705 是 3.7M 不是 4M。 */
const COMPACT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0, notation: 'compact' })
const COMPACT_ONE_DECIMAL = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 1,
  notation: 'compact',
})
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

  /* 命中率是派生数：三格输入计数都由 agent 报，这里只做一次除法 —— 与百分比
     同一条规矩。还没报过输入时是「—」，不画一个假的 0%。 */
  const inputTotal = usage.inputOther + usage.inputCacheRead + usage.inputCacheCreation
  const hitRate = inputTotal === 0 ? '—' : PERCENT.format(usage.inputCacheRead / inputTotal)

  return (
    <TooltipProvider>
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
          <div className="context-gauge__row">
            <span className="context-gauge__percent">{percent}</span>
            <span className="context-gauge__ratio">
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

          <div className="context-gauge__row context-gauge__row--section">
            <span className="context-gauge__label">token</span>
            <span className="context-gauge__value">{COMPACT_ONE_DECIMAL.format(inputTotal)}</span>
          </div>

          <div className="context-gauge__row context-gauge__row--section">
            <span className="context-gauge__label">累计命中缓存</span>
            <span className="context-gauge__value">{hitRate}</span>
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
})
