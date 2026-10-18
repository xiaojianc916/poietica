import '../../shared/styles/surface.css'
import './delegate-channel-view.css'

import { isAppError } from '@poietica/foundation'
import { Square } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { AuxiliaryComposerBar } from '../../composer'
import { describeFailure } from '../../failure'
import { SwarmIcon } from '../../shared/primitives/icons'
import type { BackgroundTaskStatus, TimelineState } from '../../shared/timeline/timeline-contract'
import { channelNameOf, delegateKey, delegationOf } from '../delegate-channel'
import { useTranscripts } from '../model/transcripts-context'
import { useAssistantSubagents, useAssistantTimeline } from '../model/use-assistant-session'
import { useAgentControls } from './agent-controls-context'
import { TranscriptView } from './transcript-view'

/*
 * 子代理通道：右坞「子代理」组里的一个标签。皮必须由这一层挂：--cp-* 只声明在 [data-assistant-skin] 下且不带兜底，不挂就整套令牌失效。
 *
 * 转录本身走 `thread#agent` 那条 feed（engine 按 agentId 分流的 transcript 通道），所以与主对话同一种画法、同一套实时。
 * 子代理收到的任务就是它自己会话里的第一句用户消息，转录里已经有了，这里不再另画首块：早先拿父对话派发调用的标题
 * 垫一个用户气泡，一次派出几个子代理时标题是「3 个子代理」，每个标签页顶上都冒出这么一句并不存在的话。
 * 底部的引导框复用辅助对话那颗输入药丸（AuxiliaryComposerBar）。
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

/* 停止要点两下：第一下只把按钮换成「确认停止」，这么久没点第二下就自己退回去。 */
const STOP_CONFIRM_MS = 3000

/**
 * 两下才生效的停止键：第一下「停止」→「确认停止」（变红），第二下才真的停；超时或失焦退回原样。
 * 停一个子代理收不回来（它这一轮的活就白干了），误触一下不该就停掉。
 */
export function ConfirmStopButton({
  confirmMs = STOP_CONFIRM_MS,
  disabled,
  onConfirm,
}: {
  readonly confirmMs?: number
  readonly disabled: boolean
  readonly onConfirm: () => void
}) {
  const [armed, setArmed] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clearTimer = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = null
  }, [])
  const disarm = useCallback(() => {
    clearTimer()
    setArmed(false)
  }, [clearTimer])
  /* 卸载（子代理结束、标签关掉）时别留一个还在走的定时器 */
  useEffect(() => clearTimer, [clearTimer])

  const onClick = () => {
    if (armed) {
      disarm()
      onConfirm()
      return
    }
    setArmed(true)
    clearTimer()
    timer.current = setTimeout(() => {
      timer.current = null
      setArmed(false)
    }, confirmMs)
  }

  return (
    <button
      aria-label={armed ? '再点一次确认停止这个子代理' : '停止这个子代理'}
      className="delegate-channel__stop"
      data-armed={armed || undefined}
      data-delegate-action="cancel"
      disabled={disabled}
      onBlur={disarm}
      onClick={onClick}
      title={armed ? '再点一次确认停止（不影响主代理）' : '停止这个子代理（不影响主代理）'}
      type="button"
    >
      <Square aria-hidden className="delegate-channel__button-icon" />
      <span>{armed ? '确认停止' : '停止'}</span>
    </button>
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
          <ConfirmStopButton disabled={busy !== null} onConfirm={() => void cancel()} />
        ) : null}
      </header>
      <div className="delegate-channel__body">
        <TranscriptView dockClearance={null} sessionKey={channel} />
      </div>
      {notice === null ? null : (
        <p className="delegate-channel__notice" role="status">
          {notice}
        </p>
      )}
      {running && controls !== null ? (
        <AuxiliaryComposerBar
          disabled={busy === 'cancel'}
          inputLabel="引导这个子代理"
          onChange={setDraft}
          onSubmit={() => void steer()}
          placeholder="引导这个子代理（它在下一步之前读到）..."
          submitDisabled={busy !== null || draft.trim() === ''}
          submitLabel="发送引导"
          value={draft}
        />
      ) : null}
    </section>
  )
}
