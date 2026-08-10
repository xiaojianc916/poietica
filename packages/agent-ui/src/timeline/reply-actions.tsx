import './reply-actions.css'

import { Check, Copy, GitFork } from 'lucide-react'
import { useCopy } from '../primitives/use-copy'

export interface ReplyActionsProps {
  readonly text: string
}

/*
 * 一轮已经完成的 AI 回复所拥有的操作。
 *
 * 组件不判断自己属于哪一轮，也不判断应该挂在哪条记录上；这些事实由 turn-fold
 * 一处决定。这里仅负责交互与视觉。三个图标全部来自 lucide-react。
 */
export function ReplyActions({ text }: ReplyActionsProps) {
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
