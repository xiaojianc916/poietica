import { channelNameOf, delegateKey, delegationOf } from '@poietica/agent'

import { SwarmIcon } from '../primitives/icons'
import { useAssistantTimeline } from '../session/use-assistant-session'
import { TranscriptView } from './transcript-view'
import { UserMessage } from './user-message'

/*
 * 一条派发通道的只读呈现。
 *
 * 它与主对话读同一个 store、同一条投影、同一套行渲染器：通道的转录就是这条会话里
 * 那个子代理自己的转录（键见 delegateKey）。所以思考、工具调用与流式追加在这里没有
 * 第二种画法。只读，所以没有输入框，也不接分叉。
 *
 * 派发时说的那一句是那次调用的入参，只有一个主人，所以它画在转录之上、不进通道的
 * 转录。通道里没有用户消息，也就没有封条。
 */

interface DelegateChannelProps {
  readonly conversationId: string
  readonly agentId: string
}

/** 标签上的那一格：一枚图标加这个子代理的名字。 */
export function DelegateChannelTab({ agentId, conversationId }: DelegateChannelProps) {
  const call = delegationOf(useAssistantTimeline(conversationId), agentId)

  return (
    <>
      <SwarmIcon aria-hidden="true" className="size-3.5 shrink-0 opacity-60" />
      <span className="min-w-0 truncate text-xs">{channelNameOf(call, agentId) ?? agentId}</span>
    </>
  )
}

export function DelegateChannelPane({ agentId, conversationId }: DelegateChannelProps) {
  const call = delegationOf(useAssistantTimeline(conversationId), agentId)

  if (call === undefined) {
    return <p className="p-4 text-xs opacity-50">这条派发不在当前对话里。</p>
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 px-4 pt-4">
        <UserMessage text={call.subject === '' ? call.title : call.subject} />
      </div>

      <TranscriptView isRestoring={false} sessionKey={delegateKey(conversationId, agentId)} />
    </div>
  )
}
