import '../surface/assistant.css'

import { channelNameOf, delegateKey, delegationOf } from '@poietica/agent'

import { SwarmIcon } from '../primitives/icons'
import { useAssistantTimeline } from '../session/use-assistant-session'
import { TranscriptView } from './transcript-view'
import { UserMessage } from './user-message'

/*
 * 一条派发通道的只读呈现。
 *
 * 皮由这一层自己挂:--cp-* 一族只声明在 [data-assistant-skin] 下,且不带兜底,所以
 * 不挂就是整套令牌失效。框、投影、行渲染器与主对话是同一套,区别只有没有输入框。
 *
 * 派发时说的那一句是那次调用的入参,主人是父对话的那次工具调用,所以它不进子代理的
 * 转录;它作为滚动盒的首块内容画出来,与转录同一个滚动盒、同一条阅读栏宽。
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

  return (
    <section className="assistant-surface" data-assistant-skin data-phase="live">
      {call === undefined ? (
        <p className="p-4 text-xs opacity-50">这条派发不在当前对话里。</p>
      ) : (
        <TranscriptView
          isRestoring={false}
          lead={<UserMessage text={call.subject === '' ? call.title : call.subject} />}
          sessionKey={delegateKey(conversationId, agentId)}
        />
      )}
    </section>
  )
}
