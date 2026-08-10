import './reply-actions.css'

import { Check, Copy, GitFork } from 'lucide-react'
import { useCopy } from '../primitives/use-copy'

export interface ReplyActionsProps {
  readonly text: string
}

/*
 * 一轮已经完成的 AI 回复所拥有的操作。
 *
 * 图标统一来自 lucide-react。复制复用已有的 useCopy，分叉目前只保留视觉入口，
 * 等真正接入会话分叉能力时再增加事件与状态。
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
