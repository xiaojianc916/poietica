import './permission-dock.css'

import { memo, useState } from 'react'
import type { ApprovalAnswer, ApprovalDecision, ApprovalScope } from '../../agent/permission'
import type { PermissionItem } from '../../timeline/timeline-contract'
import { sayToolLine } from '../semantics/tool-intent'

/**
 * 要批准的那一件事，就在下一句话的正上方。一次只画一个：并行请求彼此独立，序号只报分母。
 * 答完不留 —— 痕迹归事件日志（permission_requested / permission_resolved），转录不做第二事实来源。
 */

/** 一颗按钮，以及它代表的那个答复。 */
interface Answer {
  /** 只用来认「哪一颗正在提交」。 */
  readonly id: string
  readonly label: string
  readonly decision: Exclude<ApprovalDecision, 'cancelled'>
  readonly scope?: ApprovalScope
  readonly lead?: true
}

/* 三颗按钮，因为 kap 的答复只有三种。按钮字面由产品定（agent 不报选项表），「本次会话都批准」指明到会话结束为止、不跨会话。 */
const ANSWERS: readonly Answer[] = [
  { id: 'approve', label: '批准', decision: 'approved', lead: true },
  { id: 'approve_session', label: '本次会话都批准', decision: 'approved', scope: 'session' },
  { id: 'reject', label: '拒绝', decision: 'rejected' },
]

export interface PermissionDockProps {
  readonly item: PermissionItem
  /** 含当前这一个；为 1 时序号不出现。 */
  readonly waiting: number
  readonly onResolve: (requestId: string, answer: ApprovalAnswer) => void
}

export const PermissionDock = memo(function PermissionDock({ item, onResolve, waiting }: PermissionDockProps) {
  const [submitted, setSubmitted] = useState<string | undefined>(undefined)

  /* 换了请求就从「一个都没点」重新开始。渲染期改 state 是 React 给「props 变了复位 state」的写法，不多一帧。
     不用 key：key 会重新挂载整条带子，下一个请求顶上来时撑开动画再播一遍。 */
  const [asked, setAsked] = useState(item.requestId)

  if (asked !== item.requestId) {
    setAsked(item.requestId)
    setSubmitted(undefined)
  }

  const handleSelect = (answer: Answer) => {
    setSubmitted(answer.id)
    onResolve(item.requestId, {
      decision: answer.decision,
      ...(answer.scope === undefined ? {} : { scope: answer.scope }),
    })
  }

  /* 工具名回答不了「要不要允许 Bash」：与工具卡片同一条管线（sayToolLine 说不出就交回 null），说不出来才退到工具名。 */
  const said = sayToolLine(item) ?? item.title

  const isSubmitting = submitted !== undefined

  return (
    <div className="assistant-approval">
      {/* key 在里层：换请求时只有内容交叉淡入，外壳不重放撑开。 */}
      <div aria-busy={isSubmitting} className="assistant-approval__bar" key={item.requestId}>
        {waiting > 1 ? <span className="assistant-approval__count">1/{waiting}</span> : null}

        {/* 原样：不加前缀、不翻译、不改写。 */}
        <span className="assistant-approval__intent">{said}</span>

        <div className="assistant-approval__options">
          {ANSWERS.map((answer) => (
            <button
              className="assistant-approval__option"
              data-lead={answer.lead}
              data-pending={answer.id === submitted ? 'true' : undefined}
              disabled={isSubmitting}
              key={answer.id}
              onClick={() => {
                handleSelect(answer)
              }}
              type="button"
            >
              {answer.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
})
