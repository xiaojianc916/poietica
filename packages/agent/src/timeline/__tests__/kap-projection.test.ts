import type { RunEvent } from '@poietica/agent-contract'
import { describe, expect, it } from 'vitest'
import type {
  AgentTextItem,
  AgentThoughtItem,
  ErrorItem,
  ToolCallTimelineItem,
} from '../timeline-contract'
import { pendingPermission, pendingPermissionCall } from '../timeline-queries'
import { replayRunEvents } from '../timeline-reducer'

/**
 * kap 帧到条目的投影。
 *
 * 夹具是手写的：字段名对着上游 kap-server 的 protocol/events-zod.ts 抄，
 * 形状的权威快照钉在 contracts/kap。等真回合的录制落地（live_turn 的
 * POIETICA_KAP_CAPTURE），这份手写就该让位给录制 —— 手写只能证明「我们
 * 以为它长这样」，录制才证明「它真的长这样」。
 */

const SESSION = 'sess_kap'

/** 一轮：一问，若干 kap 事件，一个收尾。 */
function kapTurn(
  payloads: readonly (Readonly<Record<string, unknown>> & { readonly type: string })[],
): RunEvent[] {
  const events: RunEvent[] = [
    { kind: 'run_started', seq: 1, at: 1000, sessionId: SESSION, prompt: '说一句 ready' },
  ]

  payloads.forEach((payload, index) => {
    events.push({ kind: 'kap_event', seq: index + 2, at: 1010 + index, payload })
  })

  events.push({
    kind: 'run_finished',
    seq: payloads.length + 2,
    at: 2000,
    stopReason: 'completed',
  })

  return events
}

function toolCalls(state: ReturnType<typeof replayRunEvents>): ToolCallTimelineItem[] {
  return state.items.filter((item): item is ToolCallTimelineItem => item.type === 'tool_call')
}

describe('kap 投影', () => {
  it('文本增量拼进同一条消息', () => {
    const state = replayRunEvents(
      kapTurn([
        { type: 'assistant.delta', turnId: 1, delta: 'rea' },
        { type: 'assistant.delta', turnId: 1, delta: 'dy' },
      ]),
    )

    const texts = state.items.filter((item): item is AgentTextItem => item.type === 'agent_text')

    expect(texts).toHaveLength(1)
    expect(texts[0]?.text).toBe('ready')
    expect(state.status).toBe('completed')
  })

  it('思考与正文分流', () => {
    const state = replayRunEvents(
      kapTurn([
        { type: 'thinking.delta', turnId: 1, delta: '先想' },
        { type: 'assistant.delta', turnId: 1, delta: '再说' },
      ]),
    )

    const thoughts = state.items.filter(
      (item): item is AgentThoughtItem => item.type === 'agent_thought',
    )

    expect(thoughts).toHaveLength(1)
    expect(thoughts[0]?.text).toBe('先想')
    expect(state.items.some((item) => item.type === 'agent_text')).toBe(true)
  })

  it('一次工具调用的四个生命周期事件合成一张卡', () => {
    const state = replayRunEvents(
      kapTurn([
        {
          type: 'tool.call.delta',
          turnId: 1,
          toolCallId: 'call_1',
          name: 'Bash',
          argumentsPart: '{"command"',
        },
        {
          type: 'tool.call.started',
          turnId: 1,
          toolCallId: 'call_1',
          name: 'Bash',
          args: { command: 'cargo test' },
          display: { kind: 'command', command: 'cargo test' },
        },
        {
          type: 'tool.progress',
          turnId: 1,
          toolCallId: 'call_1',
          update: { kind: 'stdout', text: 'compiling…' },
        },
        { type: 'tool.result', turnId: 1, toolCallId: 'call_1', output: 'ok', isError: false },
      ]),
    )

    const calls = toolCalls(state)

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      title: 'Bash',
      kind: 'execute',
      status: 'completed',
      rawInput: { command: 'cargo test' },
      rawOutput: 'ok',
    })
    expect(calls[0]?.endedAt).toBeDefined()
    /* 进度追加成一段文本内容，不是替换掉什么。 */
    expect(calls[0]?.content).toHaveLength(1)
  })

  it('失败的调用按失败收', () => {
    const state = replayRunEvents(
      kapTurn([
        {
          type: 'tool.call.started',
          turnId: 1,
          toolCallId: 'call_2',
          name: 'Read',
          args: { file_path: 'a.txt' },
          display: { kind: 'file_io', operation: 'read', path: 'a.txt' },
        },
        { type: 'tool.result', turnId: 1, toolCallId: 'call_2', output: '不存在', isError: true },
      ]),
    )

    const calls = toolCalls(state)

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ kind: 'read', status: 'failed' })
    expect(calls[0]?.locations[0]?.path).toBe('a.txt')
  })

  it('两次调用按 id 分卡，中间隔着正文也不并', () => {
    const state = replayRunEvents(
      kapTurn([
        { type: 'tool.call.started', turnId: 1, toolCallId: 'call_a', name: 'A', args: {} },
        { type: 'assistant.delta', turnId: 1, delta: '夹在中间' },
        { type: 'tool.call.started', turnId: 1, toolCallId: 'call_b', name: 'B', args: {} },
        { type: 'tool.result', turnId: 1, toolCallId: 'call_a', output: 1, isError: false },
      ]),
    )

    const calls = toolCalls(state)

    expect(calls.map((call) => call.toolCallId)).toStrictEqual(['call_a', 'call_b'])
    expect(calls[0]?.status).toBe('completed')
    expect(calls[1]?.status).toBe('in_progress')
  })

  it('error 事件落成错误条目，code 与原文都留', () => {
    const state = replayRunEvents(
      kapTurn([{ type: 'error', code: 'provider.api_error', message: '429 insufficient balance' }]),
    )

    const errors = state.items.filter((item): item is ErrorItem => item.type === 'error')

    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ message: 'provider.api_error: 429 insufficient balance' })
  })

  it('认得的才落：轮次、仪表、回执与陌生事件一个条目都不产', () => {
    const state = replayRunEvents(
      kapTurn([
        { type: 'turn.started', turnId: 1, origin: { kind: 'user' } },
        { type: 'agent.status.updated', contextTokens: 10, maxContextTokens: 200_000 },
        { type: 'prompt.submitted', promptId: 'p1', userMessageId: 'm1', status: 'running' },
        { type: 'warning', message: '某个配置过时了' },
        { type: 'turn.ended', turnId: 1, reason: 'completed' },
        { type: 'task.started', info: {} },
      ]),
    )

    /* run_started 那一问是 withPrompt 落的，不是 kap_event 产的。 */
    expect(state.items.every((item) => item.type === 'user_message')).toBe(true)
  })

  it('审批帧走共用词汇：归一化的 toolCall 把请求接回工具卡片', () => {
    const events: RunEvent[] = [
      { kind: 'run_started', seq: 1, at: 1000, sessionId: SESSION, prompt: '跑一下测试' },
      {
        kind: 'kap_event',
        seq: 2,
        at: 1010,
        payload: {
          type: 'tool.call.started',
          turnId: 1,
          toolCallId: 'call_9',
          name: 'Bash',
          args: { command: 'cargo test' },
        },
      },
      {
        kind: 'permission_requested',
        seq: 3,
        at: 1020,
        requestId: 'appr_9',
        toolCallId: 'call_9',
        title: 'Bash',
        toolCall: {
          toolCallId: 'call_9',
          title: 'Bash',
          rawInput: { kind: 'command', command: 'cargo test' },
        },
        options: [
          { optionId: 'approve', name: 'Approve once', kind: 'allow_once' },
          { optionId: 'approve_session', name: 'Approve for this session', kind: 'allow_always' },
          { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
        ],
      },
    ]

    const state = replayRunEvents(events)
    const waiting = pendingPermission(state)

    expect(waiting?.requestId).toBe('appr_9')
    /* 反查靠的是归一化后那个 camelCase 的 toolCallId。 */
    expect(waiting?.toolCall?.toolCallId).toBe('call_9')
    expect(pendingPermissionCall(state)?.title).toBe('Bash')
  })
})
