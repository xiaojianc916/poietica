import type { DelegateMessage } from '@poietica/agent'
import { delegateChannel, delegationOf } from '@poietica/agent'

import { ModelIcon, SwarmIcon } from '../primitives/icons'
import { useAssistantTimeline } from '../session/use-assistant-session'

/*
 * 一条派发通道的只读呈现。
 *
 * 真相在转录里那条派发调用上，这里一份都不存。只读，所以没有输入框，也没有动作。
 */

interface DelegateChannelProps {
  readonly conversationId: string
  readonly toolCallId: string
}

/** 标签上的那一格：一枚图标加这次派发的名字。 */
export function DelegateChannelTab({ conversationId, toolCallId }: DelegateChannelProps) {
  const call = delegationOf(useAssistantTimeline(conversationId), toolCallId)
  const Icon = call?.kind === 'task' ? SwarmIcon : ModelIcon

  return (
    <>
      <Icon aria-hidden="true" className="size-3.5 shrink-0 opacity-60" />
      <span className="min-w-0 truncate text-xs">{call?.title ?? '子代理'}</span>
    </>
  )
}

export function DelegateChannelPane({ conversationId, toolCallId }: DelegateChannelProps) {
  const call = delegationOf(useAssistantTimeline(conversationId), toolCallId)

  if (call === undefined) {
    return <p className="p-4 text-xs opacity-50">这条派发不在当前对话里。</p>
  }

  const channel = delegateChannel(call)

  return (
    <div className="flex flex-col gap-3 p-4">
      {channel.messages.map((message) => (
        <ChannelMessage key={message.id} message={message} name={channel.title} />
      ))}
      {channel.isRunning ? <p className="px-1 text-xs opacity-50">正在工作…</p> : null}
    </div>
  )
}

function ChannelMessage({
  message,
  name,
}: {
  readonly message: DelegateMessage
  readonly name: string
}) {
  const mine = message.author === 'main'

  return (
    <div className={mine ? 'flex flex-col items-end' : 'flex flex-col items-start'}>
      <p className="px-1 pb-1 text-[11px] opacity-50">{mine ? '我' : name}</p>
      <div
        className={
          'max-w-[85%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-xs leading-relaxed ' +
          (mine ? 'bg-current/10' : 'border border-current/10')
        }
      >
        {message.text}
      </div>
    </div>
  )
}
