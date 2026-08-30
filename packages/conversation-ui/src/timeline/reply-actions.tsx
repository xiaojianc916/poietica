import './reply-actions.css'

import { useCopy } from '@poietica/design-system'
import { Check, Copy, Split } from 'lucide-react'
import { memo, type ReactNode, useCallback, useEffect, useRef, useState } from 'react'

/*
 * 回复操作的指针意图宽限期。
 *
 * 专业桌面软件通常不会在指针越过一两个像素后立刻撤走操作入口：
 * 用户已经看见工具栏并开始朝它移动，这时短暂离开目标区域仍应被视为
 * 同一次操作意图。500ms 足以修正轨迹，又不会让工具栏长时间滞留。
 */
const REPLY_ACTION_HIDE_GRACE_MS = 500

export interface ReplyActionHostProps {
  readonly children: ReactNode
  /** 这一轮之后还有几轮。分叉点就是它。 */
  readonly dropTurns: number
  /** 从这一轮分叉。缺席 = 动作不可用，按钮禁用而不是点了没反应。 */
  readonly onFork: ((dropTurns: number) => void) | undefined
  readonly text: string
}

/*
 * 一轮回复末端与操作工具栏的共同交互边界。
 *
 * 显示立即发生，隐藏延后发生。重新进入、移动到工具栏内部或取得键盘
 * 焦点都会取消隐藏。计时器归这个宿主所有，卸载时一定清除。
 */
export function ReplyActionHost({ children, dropTurns, onFork, text }: ReplyActionHostProps) {
  const [visible, setVisible] = useState(false)
  const hideTimer = useRef<number | undefined>(undefined)

  const cancelScheduledHide = useCallback(() => {
    if (hideTimer.current === undefined) {
      return
    }

    window.clearTimeout(hideTimer.current)
    hideTimer.current = undefined
  }, [])

  const showActions = useCallback(() => {
    cancelScheduledHide()
    setVisible(true)
  }, [cancelScheduledHide])

  const scheduleHide = useCallback(() => {
    cancelScheduledHide()

    hideTimer.current = window.setTimeout(() => {
      hideTimer.current = undefined
      setVisible(false)
    }, REPLY_ACTION_HIDE_GRACE_MS)
  }, [cancelScheduledHide])

  useEffect(() => cancelScheduledHide, [cancelScheduledHide])

  return (
    <div
      className="timeline-turn-end"
      data-actions-visible={visible ? 'true' : undefined}
      onBlurCapture={(event) => {
        const nextTarget = event.relatedTarget

        if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
          return
        }

        scheduleHide()
      }}
      onFocusCapture={showActions}
      onPointerEnter={showActions}
      onPointerLeave={scheduleHide}
    >
      {children}
      <ReplyActions dropTurns={dropTurns} onFork={onFork} text={text} />
    </div>
  )
}

export interface ReplyActionsProps {
  readonly dropTurns: number
  readonly onFork: ((dropTurns: number) => void) | undefined
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
/* 每一轮都能分：kap 的 :fork 复制整条，:undo 把复制件收到这一轮为止。 */
const FORK = '从这一轮分叉'
const FORK_OFF = '从这一轮分叉（不可用）'

function Actions({ dropTurns, onFork, text }: ReplyActionsProps) {
  const { copied, copy } = useCopy(text)
  const CopyStateIcon = copied ? Check : Copy

  return (
    <div className="timeline-reply-actions">
      <button
        aria-label={copied ? '已复制' : '复制回复'}
        className="timeline-reply-actions__button"
        data-copied={copied ? 'true' : undefined}
        onClick={copy}
        type="button"
      >
        <CopyStateIcon aria-hidden="true" />
      </button>

      <button
        aria-label={onFork === undefined ? FORK_OFF : FORK}
        className="timeline-reply-actions__button"
        disabled={onFork === undefined}
        onClick={() => {
          onFork?.(dropTurns)
        }}
        title={onFork === undefined ? FORK_OFF : FORK}
        type="button"
      >
        <Split aria-hidden="true" className="timeline-reply-actions__split-icon" />
      </button>
    </div>
  )
}

/*
 * 流式期间整块跳过。
 *
 * 宿主 transcript-view 的 renderRowAt 每一帧都换身份（它闭包着逐帧重建的投影），于是屏幕上每
 * 一处轮次末端每帧都被重新调用一次。而这一层的入参在轮次落定之后逐字不变，浅比较恒命中。
 * 同目录的 TurnSeal、Prose、TimelineRow 都是这个做法。
 */
export const ReplyActions = memo(Actions)
