import './prompt-queue.css'

import type { QueuedPromptItem } from '@poietica/agent'
import { memo } from 'react'
import { CloseIcon, ThreadIcon } from '../primitives/icons'
import { useAssistantQueue } from '../session/use-assistant-session'

export interface PromptQueueProps {
  /** 这一格代表的对话。队列是它的队列。 */
  readonly sessionKey: string
  /** 把这一句并进正在跑的这一轮。 */
  readonly onSteer: (promptId: string) => void
  /** 不发了。 */
  readonly onDrop: (promptId: string) => void
}

interface QueuedRowProps {
  readonly item: QueuedPromptItem
  readonly onSteer: (promptId: string) => void
  readonly onDrop: (promptId: string) => void
}

const QueuedRow = memo(function QueuedRow({ item, onDrop, onSteer }: QueuedRowProps) {
  return (
    <li className="prompt-queue__row">
      <ThreadIcon aria-hidden className="prompt-queue__mark" size={14} />

      <span className="prompt-queue__said" title={item.text}>
        {item.text}
      </span>

      <button
        className="prompt-queue__act prompt-queue__act--steer"
        onClick={() => {
          onSteer(item.promptId)
        }}
        title=""
        type="button"
      >
        {'\u21B3 提交'}
      </button>

      <button
        className="prompt-queue__act"
        onClick={() => {
          onDrop(item.promptId)
        }}
        title=""
        type="button"
      >
        <CloseIcon aria-hidden size={14} />
      </button>
    </li>
  )
})

/*
 * 输入框上方那条队列。
 *
 * 队列归 agent，这一层不攒草稿：每一行是转录里 prompt.queued 落下的那一格，按
 * promptId 认领自己。空队列时选择器交回同一个引用，所以不排队的时候它连醒都不醒。
 */
export const PromptQueue = memo(function PromptQueue({
  onDrop,
  onSteer,
  sessionKey,
}: PromptQueueProps) {
  const queued = useAssistantQueue(sessionKey)

  if (queued.length === 0) {
    return null
  }

  return (
    <ul aria-label="排队等发的话" className="prompt-queue">
      {queued.map((item) => (
        <QueuedRow item={item} key={item.promptId} onDrop={onDrop} onSteer={onSteer} />
      ))}
    </ul>
  )
})
