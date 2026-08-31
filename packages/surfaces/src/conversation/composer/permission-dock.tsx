import './permission-dock.css'

import type {
  ApprovalAnswer,
  ApprovalDecision,
  ApprovalScope,
  PermissionItem,
} from '@poietica/conversation'
import { memo, useState } from 'react'
import { sayToolLine } from '../semantics/tool-intent'

/**
 * 要批准的那一件事，就在下一句话的正上方。
 *
 * 它不是转录的一行：一次审批是拦在「继续」前面的一道闸，闸属于操作区，放进流里
 * 它会跟着滚动条走开，人得先找回它才能放行。它也不是浮在输入框上的第二块东西 ——
 * 它咬在那张卡（assistant.css 的 [data-slot="prompt-input"]）的上沿：自己画上半
 * 张脸，下沿多出一个圆角的量、被卡整个盖住。
 *
 * 接缝因此不存在，而不是被对齐：重叠的那一段盖多盖少都不露缝，所以两边没有任何
 * 一个数需要同步。
 *
 * 一次只画一个。并行的请求彼此独立，一个个答与一叠一起答在协议上没有分别，
 * 而一个个答不需要把这条带子改成队列 —— 序号只报分母（见 pendingPermissionCount）。
 *
 * 答完什么都不留。剩下的是一次操作痕迹，而痕迹归事件日志：原生侧的
 * permission_requested / permission_resolved 一条不少，转录不做第二个事实来源。
 * 见 docs/adr/0003。
 */

/** 一颗按钮，以及它代表的那个答复。 */
interface Answer {
  /** 只用来认「哪一颗正在提交」。 */
  readonly id: string
  readonly label: string
  readonly decision: Exclude<ApprovalDecision, 'cancelled'>
  readonly scope?: ApprovalScope
  /** 主按钮，只有一颗。 */
  readonly lead?: true
}

/*
 * 三颗按钮，因为 kap 的答复只有三种。
 *
 * decision × scope 是协议自己的取值域（approvalResponseSchema），不是某一家 agent
 * 报来的选项表 —— kap 的审批请求不带选项，也不带 name。所以按钮上的字由产品定：
 * 此前那张方言表要在「agent 送来什么 name」与「屏幕写什么字」之间对账，而这一侧
 * 从来没有收到过 name。
 *
 * 作用域写在字面上：「本次会话都批准」比「始终批准」说得准 —— 它到这条会话结束
 * 为止，不跨会话。
 */
const ANSWERS: readonly Answer[] = [
  { id: 'approve', label: '批准', decision: 'approved', lead: true },
  { id: 'approve_session', label: '本次会话都批准', decision: 'approved', scope: 'session' },
  { id: 'reject', label: '拒绝', decision: 'rejected' },
]

export interface PermissionDockProps {
  readonly item: PermissionItem
  /** 本段里还在等的一共几个。1 表示只有这一个，序号因此不出现。 */
  readonly waiting: number
  readonly onResolve: (requestId: string, answer: ApprovalAnswer) => void
}

export const PermissionDock = memo(function PermissionDock({
  item,
  onResolve,
  waiting,
}: PermissionDockProps) {
  const [submitted, setSubmitted] = useState<string | undefined>(undefined)

  /*
   * 换了一个请求，就该从「一个都没点」重新开始。
   *
   * 渲染期直接改自己的 state 是 React 官方给「props 变了要复位 state」的写法，
   * 本次渲染内重跑，不多一帧，也不需要 effect。不用 key：key 会把整条带子重新
   * 挂载，于是下一个请求顶上来时撑开动画会再播一遍 —— 连着三个审批闪三下。
   */
  const [asked, setAsked] = useState(item.requestId)

  if (asked !== item.requestId) {
    setAsked(item.requestId)
    setSubmitted(undefined)
  }

  /*
   * 不包 useCallback：它唯一的读者是下面那个内联箭头，而那个箭头每次渲染都是新的。
   * 稳定这一层的身份没有任何人在读，换来的只是每次渲染多一次依赖比较。
   */
  const handleSelect = (answer: Answer) => {
    setSubmitted(answer.id)
    onResolve(item.requestId, {
      decision: answer.decision,
      ...(answer.scope === undefined ? {} : { scope: answer.scope }),
    })
  }

  /*
   * 要批准的那件事本身。
   *
   * 工具名回答不了「要不要允许 Bash」。判据与工具卡片是同一条管线的两个出口
   * （sayToolLine 说不出就交回 null），两处不会各说一套；说不出来才退到工具名。
   */
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
