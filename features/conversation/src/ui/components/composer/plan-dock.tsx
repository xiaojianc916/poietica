import './plan-dock.css'

import { Prose } from '@poietica/design-system/prose'
import { memo, useState } from 'react'
import type { PlanAnswer, PlanDecision } from '../../agent/plan'
import type { PlanItem } from '../../timeline/timeline-contract'

/*
 * 待批准的计划：外框与按钮沿用授权那条带子，多出正文那一块（默认折叠，直接铺开会把输入框顶出屏幕）。
 * 三颗按钮就是三档答复；答过之后让位给一句话 —— 痕迹归事件日志，转录不做第二事实来源（与审批同此）。
 */

/**
 * 三档各自成句，因为它们在引擎那边的后果完全不同：批准让这一轮继续跑，修改与否决都留在计划模式里等下一版。
 */
function outcomeLabel(answer: { readonly decision: PlanDecision; readonly feedback: string }): string {
  if (answer.decision === 'approve') return '已批准'
  if (answer.decision === 'revise') return `已要求修改：${answer.feedback}`
  return '已否决'
}

interface Button {
  readonly id: string
  readonly label: string
  readonly decision: PlanDecision
  readonly lead?: true
}

const BUTTONS: readonly Button[] = [
  { id: 'approve', label: '批准', decision: 'approve', lead: true },
  { id: 'revise', label: '修改…', decision: 'revise' },
  { id: 'reject', label: '否决', decision: 'reject' },
]

export interface PlanDockProps {
  readonly item: PlanItem
  readonly onResolve: (interactionId: string, answer: PlanAnswer) => void
}

export const PlanDock = memo(function PlanDock({ item, onResolve }: PlanDockProps) {
  /** 已交出去的那一档答复；有值之后按钮不再画（协议上也没有第二个结果）。 */
  const [answered, setAnswered] = useState<{ readonly decision: PlanDecision; readonly feedback: string } | undefined>(
    undefined,
  )
  const [revising, setRevising] = useState(false)
  const [feedback, setFeedback] = useState('')
  /** 交了一次空意见：只提示、不答复，也不把按钮锁死。 */
  const [emptyFeedback, setEmptyFeedback] = useState(false)

  /* 换了计划就复位全部 state（渲染期复位，与 PermissionDock 同一条判据）。 */
  const [asked, setAsked] = useState(item.requestId)
  if (asked !== item.requestId) {
    setAsked(item.requestId)
    setAnswered(undefined)
    setRevising(false)
    setFeedback('')
    setEmptyFeedback(false)
  }

  const answer = (button: Button): void => {
    if (button.decision === 'revise' && !revising) {
      setRevising(true)
      setEmptyFeedback(false)
      return
    }

    const said = feedback.trim()

    if (button.decision === 'revise' && said === '') {
      /*
       * 空意见在引擎那边（planOutcomeOf）当作废处理：静悄悄换成否决是替人做了决定，所以这里只提示、不答复，按钮照旧可按。
       */
      setEmptyFeedback(true)
      return
    }

    setAnswered({ decision: button.decision, feedback: said })
    onResolve(item.requestId, {
      kind: 'plan',
      decision: button.decision,
      feedback: button.decision === 'approve' ? null : said === '' ? null : said,
    })
  }

  return (
    <div className="assistant-approval assistant-approval--plan">
      <div aria-busy={answered !== undefined} className="assistant-approval__bar" key={item.requestId}>
        <span className="assistant-approval__intent">计划待批准：{item.title}</span>
        {/* 计划文件落在哪，人据此去读全文 */}
        <span className="assistant-plan__path">{item.planFilePath}</span>

        {item.planMarkdown === '' ? null : (
          <details className="assistant-plan__details">
            <summary className="assistant-plan__summary">查看计划正文</summary>
            <div className="assistant-plan__body">
              <Prose mode="static" text={item.planMarkdown} />
            </div>
          </details>
        )}

        {revising ? (
          <textarea
            aria-label="修改意见"
            className="assistant-plan__feedback"
            onChange={(event) => {
              setFeedback(event.target.value)
              setEmptyFeedback(false)
            }}
            placeholder="说说要怎么改…"
            value={feedback}
          />
        ) : null}

        {emptyFeedback ? <span className="assistant-plan__hint">说一句要怎么改，或者点「否决」。</span> : null}

        {answered === undefined ? (
          <div className="assistant-approval__options">
            {BUTTONS.map((button) => (
              <button
                className="assistant-approval__option"
                data-lead={button.lead}
                key={button.id}
                onClick={() => {
                  answer(button)
                }}
                type="button"
              >
                {button.label}
              </button>
            ))}
          </div>
        ) : (
          <span className="assistant-plan__outcome">{outcomeLabel(answered)}</span>
        )}
      </div>
    </div>
  )
})
