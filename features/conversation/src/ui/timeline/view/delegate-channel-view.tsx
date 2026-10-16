import '../../shared/styles/surface.css'

import { useCallback } from 'react'
import { SwarmIcon } from '../../shared/primitives/icons'
import { channelNameOf, delegateKey, delegationOf } from '../delegate-channel'
import { useAssistantTimeline } from '../model/use-assistant-session'
import { TranscriptView } from './transcript-view'
import { UserMessage } from './user-message'

/* 皮必须由这一层挂：--cp-* 只声明在 [data-assistant-skin] 下且不带兜底，不挂就整套令牌失效。
 * 派发那句是父对话那次调用的入参，不属子代理转录，画成同一滚动盒的首块。 */

interface DelegateChannelProps {
  readonly conversationId: string
  readonly agentId: string
}

/** 行本身归标签条画：通道与宿主标签是同一种行。 */
export function DelegateChannelIcon() {
  return <SwarmIcon aria-hidden="true" className="size-3.5 shrink-0 opacity-60" />
}

/** 名字住在派发它的那次调用上，所以要订这条对话的转录；没有对话可读时退回 agentId 本身。 */
export function useDelegateChannelNames(conversationId: string | null): (agentId: string) => string {
  const timeline = useAssistantTimeline(conversationId ?? '')

  return useCallback(
    (agentId: string) =>
      conversationId === null ? agentId : (channelNameOf(delegationOf(timeline, agentId), agentId) ?? agentId),
    [conversationId, timeline],
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
          dockClearance={null}
          lead={<UserMessage text={call.subject === '' ? call.title : call.subject} />}
          sessionKey={delegateKey(conversationId, agentId)}
        />
      )}
    </section>
  )
}
