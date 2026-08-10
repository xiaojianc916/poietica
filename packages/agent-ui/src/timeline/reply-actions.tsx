import './reply-actions.css'

import type { SVGProps } from 'react'
import { CheckIcon, CopyIcon } from '../primitives/icons'
import { useCopy } from '../primitives/use-copy'

export interface ReplyActionsProps {
  readonly text: string
}

/*
 * 图标库当前没有在本仓语义映射中暴露“分叉”字形。
 *
 * 这一枚先作为本组件的局部字形存在。分叉功能接入时，如果其它界面也需要它，
 * 再把语义映射提升到 primitives/icons.ts；在只有一个消费者时不提前扩大公共 API。
 */
function BranchIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 24 24" {...props}>
      <circle cx="6" cy="5" r="2" />
      <circle cx="18" cy="5" r="2" />
      <circle cx="12" cy="19" r="2" />
      <path d="M6 7v2.5c0 2.2 1.8 4 4 4h2" />
      <path d="M18 7v2.5c0 2.2-1.8 4-4 4h-2" />
      <path d="M12 13.5V17" />
    </svg>
  )
}

/*
 * 一轮 AI 回复的操作区。
 *
 * 它绝对定位在回复正文之后，不参与行高计算，因此不会把下一条用户气泡向下推。
 * 复制走已有的 useCopy，分叉暂时只提供视觉入口。
 */
export function ReplyActions({ text }: ReplyActionsProps) {
  const { copied, copy } = useCopy(text)
  const CopyStateIcon = copied ? CheckIcon : CopyIcon

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
        <BranchIcon />
      </button>
    </div>
  )
}
