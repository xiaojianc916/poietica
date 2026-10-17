import '../../shared/styles/surface.css'
import './delegate-channel-view.css'

import { isAppError } from '@poietica/foundation'
import { Send, Square } from 'lucide-react'
import { type FormEvent, type KeyboardEvent, useCallback, useEffect, useState } from 'react'
import { describeFailure } from '../../failure'
import { SwarmIcon } from '../../shared/primitives/icons'
import type { BackgroundTaskStatus, TimelineState } from '../../shared/timeline/timeline-contract'
import { channelNameOf, delegateKey, delegationOf } from '../delegate-channel'
import { useTranscripts } from '../model/transcripts-context'
import { useAssistantSubagents, useAssistantTimeline } from '../model/use-assistant-session'
import { useAgentControls } from './agent-controls-context'
import { TranscriptView } from './transcript-view'
import { UserMessage } from './user-message'

/*
 * 子代理通道：右坞「子代理」组里的一个标签。皮必须由这一层挂：--cp-* 只声明在 [data-assistant-skin] 下且不带兜底，不挂就整套令牌失效。
 *
 * 转录本身走 `thread#agent` 那条 feed（engine 按 agentId 分流的 transcript 通道），所以与主对话同一种画法、同一套实时；
 * 派发那句是父对话那次调用的入参，不属子代理转录，画成同一滚动盒的首块。父对话里找不到那次调用（异步派发、重开旧对话、
 * 调用已滚出已载入的页）时**照样画**转录，只是不画首块 —— 早先这里整块换成一句「这条派发不在当前对话里」，等于通道打不开。
 */

interface DelegateChannelProps {
  readonly conversationId: string
  readonly agentId: string
}

/** 行本身归标签条画：通道与宿主标签是同一种行。 */
export function DelegateChannelIcon() {
  return <SwarmIcon aria-hidden="true" className="size-3.5 shrink-0 opacity-60" />
}

const STATUS_LABEL: Record<BackgroundTaskStatus, string> = {
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  timed_out: '已超时',
  killed: '已停止',
  lost: '已中断',
}

/** 名字的回查次序：子代理表的描述 → 派发调用上的通道名 → agentId 本身。纯函数，右坞标签条（不在 React 里）也用它。 */
export function subagentTitleOf(
  timeline: Pick<TimelineState, 'subagents' | 'sealed' | 'active'>,
  agentId: string,
): string {
  const listed = timeline.subagents.find((one) => one.agentId === agentId)?.description
  if (listed !== undefined && listed !== '') return listed
  return channelNameOf(delegationOf(timeline as TimelineState, agentId), agentId) ?? agentId
}

/**
 * 状态的回查次序：子代理表（引擎报的生命周期，权威）→ 派发调用的状态（没有生命周期帧的旧对话）→ 不知道。
 * 「不知道」时不画引导框与停止键：对一个已经收尾的子代理发话只会换来一句拒绝。
 */
function statusOf(timeline: TimelineState, agentId: string): BackgroundTaskStatus | null {
  const listed = timeline.subagents.find((one) => one.agentId === agentId)?.status
  if (listed !== undefined) return listed
  const call = delegationOf(timeline, agentId)
  if (call === undefined) return null
  if (call.status === 'in_progress' || call.status === 'pending') return 'running'
  return call.status === 'failed' ? 'failed' : 'completed'
}

/** 名字住在派发它的那次调用上，所以要订这条对话的转录；没有对话可读时退回 agentId 本身。 */
export function useDelegateChannelNames(conversationId: string | null): (agentId: string) => string {
  const timeline = useAssistantTimeline(conversationId ?? '')

  return useCallback(
    (agentId: string) => (conversationId === null ? agentId : subagentTitleOf(timeline, agentId)),
    [conversationId, timeline],
  )
}

function failureText(cause: unknown): string {
  return isAppError(cause) && cause.message.length > 0 ? cause.message : describeFailure(cause)
}

export function DelegateChannelPane({ agentId, conversationId }: DelegateChannelProps) {
  const transcripts = useTranscripts()
  const channel = delegateKey(conversationId, agentId)
  /* 在效果里做：它会发命令（整读这个子代理的 feed）。早已结束的子代理不会再有 ops 来触发读取，所以挂上就读一次。 */
  useEffect(() => {
    transcripts.openChannel(channel)
  }, [channel, transcripts])
  const timeline = useAssistantTimeline(conversationId)
  /* 子代理表单独订一份：它变得比整条时间线少，状态行跟着它走。 */
  useAssistantSubagents(conversationId)
  const controls = useAgentControls()
  const call = delegationOf(timeline, agentId)
  const title = subagentTitleOf(timeline, agentId)
  const status = statusOf(timeline, agentId)
  const running = status === 'running'
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState<'steer' | 'cancel' | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const steer = useCallback(async () => {
    const text = draft.trim()
    if (controls === null || text === '' || busy !== null) return
    setBusy('steer')
    setNotice(null)
    try {
      await controls.steerSubagent(conversationId, agentId, text)
      setDraft('')
    } catch (cause) {
      setNotice(failureText(cause))
    } finally {
      setBusy(null)
    }
  }, [agentId, busy, controls, conversationId, draft])

  const cancel = useCallback(async () => {
    if (controls === null || busy !== null) return
    setBusy('cancel')
    setNotice(null)
    try {
      const cancelled = await controls.cancelSubagent(conversationId, agentId)
      if (!cancelled) setNotice('这个子代理已经结束了')
    } catch (cause) {
      setNotice(failureText(cause))
    } finally {
      setBusy(null)
    }
  }, [agentId, busy, controls, conversationId])

  const onSubmit = (event: FormEvent) => {
    event.preventDefault()
    void steer()
  }
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    /* 与主输入框同一条键位：Enter 发送、Shift+Enter 换行；输入法组字时的 Enter 不算。 */
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      void steer()
    }
  }

  return (
    <section
      className="assistant-surface delegate-channel"
      data-assistant-skin
      data-delegate-status={status ?? 'unknown'}
      data-phase="live"
    >
      <header className="delegate-channel__header">
        <SwarmIcon aria-hidden="true" className="delegate-channel__icon" />
        <span className="delegate-channel__title" title={title}>
          {title}
        </span>
        {status === null ? null : <span className="delegate-channel__status">{STATUS_LABEL[status]}</span>}
        {running && controls !== null ? (
          <button
            aria-label="停止这个子代理"
            className="delegate-channel__stop"
            data-delegate-action="cancel"
            disabled={busy !== null}
            onClick={() => void cancel()}
            title="停止这个子代理（不影响主代理）"
            type="button"
          >
            <Square aria-hidden className="delegate-channel__button-icon" />
            <span>停止</span>
          </button>
        ) : null}
      </header>
      <div className="delegate-channel__body">
        <TranscriptView
          dockClearance={null}
          lead={call === undefined ? undefined : <UserMessage text={call.subject === '' ? call.title : call.subject} />}
          sessionKey={channel}
        />
      </div>
      {notice === null ? null : (
        <p className="delegate-channel__notice" role="status">
          {notice}
        </p>
      )}
      {running && controls !== null ? (
        <form className="delegate-channel__steer" onSubmit={onSubmit}>
          <textarea
            aria-label="引导这个子代理"
            className="delegate-channel__input"
            disabled={busy === 'cancel'}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="给这个子代理插一句话（它在下一步之前读到）"
            rows={2}
            value={draft}
          />
          <button
            aria-label="发送引导"
            className="delegate-channel__send"
            data-delegate-action="steer"
            disabled={busy !== null || draft.trim() === ''}
            type="submit"
          >
            <Send aria-hidden className="delegate-channel__button-icon" />
          </button>
        </form>
      ) : null}
    </section>
  )
}
