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
 * 组件不判断自己属于哪一轮，也不判断应该挂在哪条记录上；这些事实由 turn-fold 一处决定。
 * 这里仅负责交互与视觉。三个图标全部来自 lucide-react。
 *
 * 外层是纯布局节点，不带 ARIA 角色。两个按钮各自有名字，包一层 role="group" 只会多出一
 * 层空壳分组；真正贴合这块 UI 的是 toolbar，但 WAI-ARIA APG 的 toolbar 要求整条是单个
 * Tab 停靠点、成员间用方向键移动、禁用成员改用 aria-disabled 以保持可聚焦 —— 那要连
 * reply-actions.css 里的 :disabled 与 :hover:not(:disabled) 一起改。宁可不声明，也不声明
 * 一个自己不履行的角色。
 */
function Actions({ text }: ReplyActionsProps) {
  const { copied, copy } = useCopy(text)
  const CopyStateIcon = copied ? Check : Copy

  return (
    <div className="timeline-reply-actions">
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
 * 宿主 renderRowWithSeal 每一帧都换身份（它闭包着 foldFeed 交出的两张表），于是屏幕上每
 * 一处轮次末端每帧都被重新调用一次。而这一层的入参只有一段已经定稿的文字：轮次落定之后
 * 它逐字不变，浅比较恒命中。同目录的 TurnSeal、Prose、TimelineRow 都是这个做法。
 */
export const ReplyActions = memo(Actions)
