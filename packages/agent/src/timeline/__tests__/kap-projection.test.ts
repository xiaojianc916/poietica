import { describe, expect, it } from 'bun:test'
import type { RunEvent } from '@poietica/agent-contract'
import { agentStampOf } from '../kap-projection'
import {
  type AgentTextItem,
  type AgentThoughtItem,
  allItems,
  type ErrorItem,
  type ToolCallTimelineItem,
} from '../timeline-contract'
import { activeScope, pendingPermission, pendingPermissionCall } from '../timeline-queries'
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
    {
      kind: 'prompt_admitted',
      admissionId: 'adm',
      seq: 1,
      at: 1000,
      sessionId: SESSION,
      prompt: '说一句 ready',
    },
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
  return allItems(state).filter((item): item is ToolCallTimelineItem => item.type === 'tool_call')
}

describe('kap 投影', () => {
  it('文本增量拼进同一条消息', () => {
    const state = replayRunEvents(
      kapTurn([
        { type: 'assistant.delta', turnId: 1, delta: 'rea' },
        { type: 'assistant.delta', turnId: 1, delta: 'dy' },
      ]),
    )

    const texts = allItems(state).filter(
      (item): item is AgentTextItem => item.type === 'agent_text',
    )

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

    const thoughts = allItems(state).filter(
      (item): item is AgentThoughtItem => item.type === 'agent_thought',
    )

    expect(thoughts).toHaveLength(1)
    expect(thoughts[0]?.text).toBe('先想')
    expect(allItems(state).some((item) => item.type === 'agent_text')).toBe(true)
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
    /* 一句进度落成一段文本内容；产出是字符串，那一面由 rawOutput 画。 */
    expect(calls[0]?.content).toHaveLength(1)
  })

  it('入参流片不先立一张兜底卡：卡出现时分类与主语已经就位', () => {
    const streaming: RunEvent[] = [
      {
        kind: 'prompt_admitted',
        admissionId: 'adm',
        seq: 1,
        at: 1000,
        sessionId: SESSION,
        prompt: '跑一下测试',
      },
      {
        kind: 'kap_event',
        seq: 2,
        at: 1010,
        payload: {
          type: 'tool.call.delta',
          turnId: 1,
          toolCallId: 'call_f',
          name: 'Bash',
          argumentsPart: '{"command"',
        },
      },
    ]

    /* 半个 JSON 说不出这次调用是什么：没有 display 就没有卡，也就没有兜底的一帧。 */
    expect(toolCalls(replayRunEvents(streaming))).toHaveLength(0)

    const announced = replayRunEvents([
      ...streaming,
      {
        kind: 'kap_event',
        seq: 3,
        at: 1020,
        payload: {
          type: 'tool.call.started',
          turnId: 1,
          toolCallId: 'call_f',
          name: 'Bash',
          args: { command: 'cargo test' },
          display: { kind: 'command', command: 'cargo test' },
        },
      },
    ])

    expect(toolCalls(announced)).toHaveLength(1)
    expect(toolCalls(announced)[0]).toMatchObject({ kind: 'execute', subject: 'cargo test' })
  })

  it('说了 replace 的进度盖掉上一截，不堆成两行', () => {
    const state = replayRunEvents(
      kapTurn([
        { type: 'tool.call.started', turnId: 1, toolCallId: 'call_p', name: 'Fetch', args: {} },
        {
          type: 'tool.progress',
          turnId: 1,
          toolCallId: 'call_p',
          update: { kind: 'status', text: '下载 40%', replace: true },
        },
        {
          type: 'tool.progress',
          turnId: 1,
          toolCallId: 'call_p',
          update: { kind: 'status', text: '下载 80%', replace: true },
        },
      ]),
    )

    expect(toolCalls(state)[0]?.content).toStrictEqual([
      { type: 'content', content: { type: 'text', text: '下载 80%' } },
    ])
  })

  it('一组内容部件的产出摊成内容块，不印成一坨 JSON', () => {
    const state = replayRunEvents(
      kapTurn([
        { type: 'tool.call.started', turnId: 1, toolCallId: 'call_o', name: 'Shot', args: {} },
        {
          type: 'tool.result',
          turnId: 1,
          toolCallId: 'call_o',
          output: [
            { type: 'text', text: '截好了' },
            { type: 'image_url', imageUrl: { url: 'https://x/y.png' } },
          ],
          isError: false,
        },
      ]),
    )

    expect(toolCalls(state)[0]?.content).toStrictEqual([
      { type: 'content', content: { type: 'text', text: '截好了' } },
      { type: 'resource_link', uri: 'https://x/y.png' },
    ])
  })

  it('认不出的部件整份退回原样，不翻译一半', () => {
    const output = [{ type: 'text', text: '一半' }, { type: 'brand_new_part' }]
    const state = replayRunEvents(
      kapTurn([
        { type: 'tool.call.started', turnId: 1, toolCallId: 'call_u', name: 'Odd', args: {} },
        { type: 'tool.result', turnId: 1, toolCallId: 'call_u', output, isError: false },
      ]),
    )

    const call = toolCalls(state)[0]

    expect(call?.content).toStrictEqual([])
    expect(call?.rawOutput).toStrictEqual(output)
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

    const errors = allItems(state).filter((item): item is ErrorItem => item.type === 'error')

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

    /* 那一问是 prompt_admitted 由 withPrompt 落的，不是 kap_event 产的。 */
    const notAsked = allItems(state).filter((item) => item.type !== 'user_message')

    /*
     * 空转完成一个条目都不产：空回复不是错误（terminal-outcome 的判例）。
     * 失败与受阻的轮次才落账 —— turn.ended 按 agentId 过滤后写结构化错误。
     */
    expect(notAsked).toHaveLength(0)
  })

  it('分类与主语来自 display，一档一映', () => {
    const state = replayRunEvents(
      kapTurn([
        {
          type: 'tool.call.started',
          turnId: 1,
          toolCallId: 'call_w',
          name: 'Write',
          args: { file_path: 'a.ts', content: 'export {}' },
          display: { kind: 'file_io', operation: 'write', path: 'a.ts', content: 'export {}' },
        },
        {
          type: 'tool.call.started',
          turnId: 1,
          toolCallId: 'call_g',
          name: 'Grep',
          args: { pattern: 'todo' },
          display: { kind: 'file_io', operation: 'grep', path: 'src' },
        },
        {
          type: 'tool.call.started',
          turnId: 1,
          toolCallId: 'call_s',
          name: 'Agent',
          args: { subagent_type: 'coder', prompt: '查一遍超时重试' },
          display: {
            kind: 'agent_call',
            agent_name: 'coder',
            prompt: '查一遍超时重试',
            background: true,
          },
        },
        {
          type: 'tool.call.started',
          turnId: 1,
          toolCallId: 'call_m',
          name: 'mcp__ramp__list_bills',
          args: {},
          display: { kind: 'generic', summary: '列出账单' },
        },
      ]),
    )

    const calls = toolCalls(state)

    expect(calls.map((call) => call.kind)).toStrictEqual(['write', 'search', 'delegate', 'other'])
    /* 写进去的正文由 display 给，落在送出去那一面 —— 它是入参，不是产出。 */
    expect(calls[0]?.requestContent).toStrictEqual([
      { type: 'diff', path: 'a.ts', newText: 'export {}' },
    ])
    expect(calls[0]?.content).toStrictEqual([])
    /* 被搜的范围不是被碰的文件：locations 空着，组卡不会把它数成一次阅读。 */
    expect(calls[1]?.locations).toStrictEqual([])
    expect(calls[2]).toMatchObject({ isBackground: true, subject: '查一遍超时重试' })
    expect(calls[3]?.subject).toBe('列出账单')
  })

  it('一次读不会被合成成一次写入', () => {
    const state = replayRunEvents(
      kapTurn([
        {
          type: 'tool.call.started',
          turnId: 1,
          toolCallId: 'call_r',
          name: 'Read',
          args: { file_path: 'a.ts' },
          display: { kind: 'file_io', operation: 'read', path: 'a.ts', content: 'export {}' },
        },
      ]),
    )

    const call = toolCalls(state)[0]

    expect(call).toMatchObject({ kind: 'read', subject: 'a.ts' })
    expect(call?.requestContent).toStrictEqual([])
    expect(call?.content).toStrictEqual([])
  })

  it('display 缺席时主语退回派发自己写的那一句', () => {
    const state = replayRunEvents(
      kapTurn([
        {
          type: 'tool.call.started',
          turnId: 1,
          toolCallId: 'call_d',
          name: 'TodoList',
          args: {},
          description: '更新任务清单',
        },
      ]),
    )

    expect(toolCalls(state)[0]).toMatchObject({ kind: 'other', subject: '更新任务清单' })
  })

  it('命令、清单与计划都从 display 落进送出去那一面', () => {
    const state = replayRunEvents(
      kapTurn([
        {
          type: 'tool.call.started',
          turnId: 1,
          toolCallId: 'call_c',
          name: 'Bash',
          args: { command: 'bun run check' },
          display: { kind: 'command', command: 'bun run check', language: 'bash' },
        },
        {
          type: 'tool.call.started',
          turnId: 1,
          toolCallId: 'call_t',
          name: 'TodoWrite',
          args: {},
          display: {
            kind: 'todo_list',
            items: [
              { title: '建索引', status: 'done' },
              { title: '写投影', status: 'in_progress' },
              { title: '补用例', status: 'whatever' },
            ],
          },
        },
        {
          type: 'tool.call.started',
          turnId: 1,
          toolCallId: 'call_pl',
          name: 'ExitPlanMode',
          args: {},
          display: { kind: 'plan_review', plan: '## 步骤\n\n先读契约。' },
        },
      ]),
    )

    const calls = toolCalls(state)

    /* 语言标注由 kap 给，不是我们猜的。 */
    expect(calls[0]?.requestContent).toStrictEqual([
      { type: 'command', command: 'bun run check', language: 'bash' },
    ])
    /* 认不出的状态一律待办，与上游客户端同一条归一化。 */
    expect(calls[1]?.requestContent).toStrictEqual([
      {
        type: 'todo',
        items: [
          { title: '建索引', status: 'done' },
          { title: '写投影', status: 'in_progress' },
          { title: '补用例', status: 'pending' },
        ],
      },
    ])
    expect(calls[2]?.requestContent).toStrictEqual([
      { type: 'prose', text: '## 步骤\n\n先读契约。' },
    ])
    /* 三次都还没有产出：送出去与交回来是两格。 */
    expect(calls.every((call) => call.content.length === 0)).toBe(true)
  })

  it('缺了语言标注的命令按 bash 画', () => {
    const state = replayRunEvents(
      kapTurn([
        {
          type: 'tool.call.started',
          turnId: 1,
          toolCallId: 'call_nb',
          name: 'Bash',
          args: {},
          display: { kind: 'command', command: 'ls -la' },
        },
      ]),
    )

    expect(toolCalls(state)[0]?.requestContent).toStrictEqual([
      { type: 'command', command: 'ls -la', language: 'bash' },
    ])
  })
  it('审批帧走共用词汇：归一化的 toolCall 把请求接回工具卡片', () => {
    const events: RunEvent[] = [
      {
        kind: 'prompt_admitted',
        admissionId: 'adm',
        seq: 1,
        at: 1000,
        sessionId: SESSION,
        prompt: '跑一下测试',
      },
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
      },
    ]

    const state = replayRunEvents(events)
    const waiting = pendingPermission(activeScope(state))

    expect(waiting?.requestId).toBe('appr_9')
    /* 反查靠的是归一化后那个 camelCase 的 toolCallId。 */
    expect(waiting?.toolCall?.toolCallId).toBe('call_9')
    expect(pendingPermissionCall(activeScope(state))?.title).toBe('Bash')
  })
})

describe('kap agent stamp', () => {
  it('keeps protocol routing knowledge in kap-projection', () => {
    const delegated: RunEvent = {
      kind: 'kap_event',
      seq: 1,
      at: 1,
      payload: { type: 'assistant.delta', agentId: 'worker-1', delta: 'hi' },
    }
    const main: RunEvent = {
      kind: 'kap_event',
      seq: 2,
      at: 2,
      payload: { type: 'assistant.delta', agentId: 'main', delta: 'hi' },
    }
    expect(agentStampOf(delegated)).toBe('worker-1')
    expect(agentStampOf(main)).toBeUndefined()
  })
})
