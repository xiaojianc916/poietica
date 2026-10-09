import './plan-dock.css'

import { memo, useState } from 'react'
import type { PlanAnswer, PlanDecision } from '../../agent/plan'
import type { PlanItem } from '../../timeline/timeline-contract'
import { Prose } from '../timeline/prose'

/*
 * 待批准的计划（04 页 §3.12 的第 5 支、产品负责人 2026-10-07 定稿的卡片形状）。
 *
 * 外框与按钮沿用授权那条带子（同一张 `assistant-approval` 脸，样式在 permission-dock.css
 * 与 plan-dock.css），多出来的是正文那一块：计划是一篇 Markdown，默认折叠、点开才铺开 ——
 * 直接铺开会把输入框顶出屏幕。
 *
 * 三颗按钮就是那一档答复：批准 / 修改…（展开一个反馈输入框）/ 否决。答过之后三颗按钮让位
 * 给一句话（已批准 / 已要求修改：… / 已否决），随即整张卡消失 —— 痕迹归事件日志，转录不做
 * 第二事实来源（与审批同此）。那句话是这一格在屏幕上的最后一帧。
 */

/**
 * 答复之后卡片上那句话。
 *
 * 三档各自成句，因为它们在引擎那边的后果完全不同：批准会让这一轮继续跑，修改与否决都
 * 留在计划模式里等下一版。措辞与交回模型的工具结果同一套词（见 interactions/plan.ts）。
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
  /** 主按钮，只有一颗。 */
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
  /** 已经交出去的那一档答复；有值之后按钮不再画（重复答复在协议上也没有第二个结果）。 */
  const [answered, setAnswered] = useState<{ readonly decision: PlanDecision; readonly feedback: string } | undefined>(
    undefined,
  )
  const [revising, setRevising] = useState(false)
  const [feedback, setFeedback] = useState('')
  /** 「修改…」交了一次空意见：提示留在原地，卡片不作答复（也不把三颗按钮锁死）。 */
  const [emptyFeedback, setEmptyFeedback] = useState(false)

  /* 换了计划就从「一个都没点」重新开始（与 PermissionDock 同一条判据：渲染期复位 state）。 */
  const [asked, setAsked] = useState(item.requestId)
  if (asked !== item.requestId) {
    setAsked(item.requestId)
    setAnswered(undefined)
    setRevising(false)
    setFeedback('')
    setEmptyFeedback(false)
  }

  const answer = (button: Button): void => {
    /* 「修改…」不直接交答复：先展开反馈输入框，等人在里面写完意见再提交。 */
    if (button.decision === 'revise' && !revising) {
      setRevising(true)
      setEmptyFeedback(false)
      return
    }

    const said = feedback.trim()

    if (button.decision === 'revise' && said === '') {
      /*
       * 说了要改却一个字没给：引擎那边（planOutcomeOf）把空意见当作废处理，但人点的是
       * 「修改…」，静悄悄换成否决是替他做了决定。所以这里只提示、不答复，按钮照旧可按 ——
       * 他可以写一句，也可以改去点否决。
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
        {/* 副行：计划文件落在哪（人据此去读全文） */}
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
