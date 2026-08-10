import './reply-actions.css'

import { Check, Copy, GitFork } from 'lucide-react'
import { memo } from 'react'
import { useCopy } from '../primitives/use-copy'

export interface ReplyActionsProps {
  readonly text: string
}

/*
 * 一轮已经完成的 AI 回复所拥有的操作。
 *
 * 组件不判断自己属于哪一轮，也不判断应该挂在哪条记录上；这些事实由 turn-fold 一处
 * 决定。这里仅负责交互与视觉。三个图标全部来自 lucide-react。
 */
function Actions({ text }: ReplyActionsProps) {
  const { copied, copy } = useCopy(text)
  const CopyStateIcon = copied ? Check : Copy

  return (
    <div aria-label="回复操作" className="timeline-reply-actions" role="group">
      <button
        aria-label={copied ? '已复制' : '复制回复'}
        className="timeline-reply-actions__button"
        data-copied={copied ? 'true' : undefined}
        onClick={copy}
        title={copied ? '已复制' : '复制'}
        type="button"
      >
        <CopyStateIcon aria-hidden="true" />
      </button>

      <button
        aria-label="分叉对话（即将推出）"
        className="timeline-reply-actions__button"
        disabled
        title="分叉对话（即将推出）"
        type="button"
      >
        <GitFork aria-hidden="true" />
      </button>
    </div>
  )
}

/*
 * 流式期间整块跳过。
 *
 * 宿主 renderRowWithSeal 每一帧都换身份（它闭包着 foldFeed 交出的两张表），于是屏幕上
 * 每一处轮次末端每帧都被重新调用一次。而这一层的入参只有一段已经定稿的文字：轮次落定
 * 之后它逐字不变，浅比较恒命中。同目录的 TurnSeal、Prose、TimelineRow 都是这个做法。
 */
export const ReplyActions = memo(Actions)
