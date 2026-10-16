import { expect, test } from 'bun:test'
import { type Interaction, type InteractionAnswer, interactionCardOf } from '@poietica/engine'
import { applyOps, emptyTimeline, type TranscriptInteraction, type TranscriptOperation } from '@poietica/transcript'
import type { TranscriptPage } from '../../../shared/model/transcript'
import { createProjectionMemo, projectTranscript } from '../transcript-projector'

/*
 * 交互卡片的整条链（Q1-C）：引擎的 `Interaction` → `interactionCardOf` → 时间线条目。
 * 从前载荷是 `unknown`，界面按自己记得的字段名去掏（`toolName`、`question`、`multiSelect`……），
 * 而引擎发的是 `tool`、`prompt`、`multiple` —— 主语空、题面空、多选与「其他」都丢了，没有一条测试看得见。
 */

const base = { id: 'i1', createdAt: 0, timeoutAt: null }

const APPROVAL: Interaction = {
  ...base,
  kind: 'approval',
  tool: 'bash',
  title: '允许使用工具：bash',
  detail: 'Command: rm -rf build',
  allowSessionScope: true,
}

const QUESTION: Interaction = {
  ...base,
  kind: 'question',
  questions: [
    {
      id: 'q0',
      prompt: '用哪个运行时？',
      multiple: true,
      allowCustom: true,
      options: [
        { id: 'o0', label: 'bun', description: '快' },
        { id: 'o1', label: 'node', description: null },
      ],
    },
    {
      id: 'q1',
      prompt: '要不要顺手升级？',
      multiple: false,
      allowCustom: true,
      options: [{ id: 'o0', label: '要', description: null }],
    },
  ],
}

const PLAN: Interaction = {
  ...base,
  kind: 'plan',
  title: '迁移测试',
  planFilePath: 'local://migrate-plan.md',
  planMarkdown: '# 计划',
}

const AT = '2026-10-10T00:00:00.000Z'

/** 一轮里一次 ask 调用：答过的题组按调用号长进它的产出里。 */
const ASK_TURN = [
  {
    op: 'turn.upsert',
    turn: {
      kind: 'turn',
      turnId: 't1',
      ordinal: 1,
      state: 'completed',
      origin: { kind: 'user' },
      prompt: '问我',
      startedAt: AT,
    },
  },
  {
    op: 'step.upsert',
    turnId: 't1',
    step: { kind: 'step', stepId: 't1:s0', turnId: 't1', ordinal: 0, state: 'completed', startedAt: AT },
  },
  {
    op: 'frame.upsert',
    turnId: 't1',
    stepId: 't1:s0',
    frame: { kind: 'tool', frameId: 't1:s0:f0', toolCallId: 'call-1', name: 'ask', state: 'done', output: '原始产出' },
  },
] as unknown as TranscriptOperation[]

function pageWith(
  interactions: readonly TranscriptInteraction[],
  ops: readonly TranscriptOperation[] = [],
): TranscriptPage {
  return {
    items: applyOps(emptyTimeline(), ops).items,
    tasks: [],
    interactions,
    attachments: [],
    todos: [],
    prompts: [],
    meta: {},
    hasMoreOlder: false,
    agentId: 'main',
    agents: [],
    pendingInteractions: interactions.filter((i) => i.state === 'pending').map((i) => i.interactionId),
    seq: 1,
  } as unknown as TranscriptPage
}

function itemsOf(interaction: Interaction, answer?: InteractionAnswer) {
  const card = interactionCardOf(interaction, answer === undefined ? undefined : { answer })
  return projectTranscript(pageWith([card]), createProjectionMemo()).active.items
}

test('I1 待答审批：主语是工具名，带子上是上游算好的那一段', () => {
  const [item] = itemsOf(APPROVAL)
  expect(item).toMatchObject({
    type: 'permission',
    requestId: 'i1',
    subject: 'bash',
    title: 'Command: rm -rf build',
    headline: 'Command: rm -rf build',
  })
  expect(item?.type === 'permission' ? item.resolution : 'x').toBeUndefined()
})

test('I2 待答提问：题面、多选与「其他」照引擎的题画', () => {
  const [item] = itemsOf(QUESTION)
  if (item?.type !== 'question') throw new Error('不是提问')
  expect(item.questions).toEqual([
    {
      id: 'q0',
      question: '用哪个运行时？',
      options: [
        { id: 'o0', label: 'bun', description: '快' },
        { id: 'o1', label: 'node' },
      ],
      multiSelect: true,
      allowOther: true,
    },
    {
      id: 'q1',
      question: '要不要顺手升级？',
      options: [{ id: 'o0', label: '要' }],
      multiSelect: false,
      allowOther: true,
    },
  ])
  expect(item.resolution).toBeUndefined()
})

test('I3 答过的提问长进发起它的那次调用：题面还在，答复按题号翻回人话', () => {
  const card = interactionCardOf(QUESTION, {
    answer: {
      kind: 'question',
      answers: { q0: { selected: ['o0', 'o1'], custom: 'deno' }, q1: { selected: [], custom: null } },
    },
  })
  const items = projectTranscript(pageWith([{ ...card, toolCallId: 'call-1' }], ASK_TURN), createProjectionMemo())
    .active.items
  const ask = items.find((item) => item.type === 'tool_call')
  expect(ask?.type === 'tool_call' ? ask.content : null).toEqual([
    { type: 'prose', text: '用哪个运行时？\n\n**bun、node、deno**\n\n要不要顺手升级？\n\n**跳过**' },
  ])
})

test('I4 计划收口之后正文还在：收口那一次 upsert 也带着请求', () => {
  const [item] = itemsOf(PLAN, { kind: 'plan', decision: 'revise', feedback: '先拆小' })
  expect(item).toMatchObject({
    type: 'plan',
    title: '迁移测试',
    planFilePath: 'local://migrate-plan.md',
    planMarkdown: '# 计划',
    resolution: { decision: 'revise', feedback: '先拆小' },
  })
})

test('I5 撤下没有答复：终态由 state 说，response 缺席', () => {
  const card = interactionCardOf(APPROVAL, { answer: { kind: 'dismiss' } })
  expect(card.state).toBe('cancelled')
  expect(card.response).toBeUndefined()
  expect(card.request).toEqual({
    toolName: 'bash',
    title: '允许使用工具：bash',
    detail: 'Command: rm -rf build',
    allowSessionScope: true,
  })
})

test('I6 确认类有自己的卡片：按单问画在输入框里，确认是 approved、不确认是 rejected（Q1-E）', () => {
  const confirm: Interaction = { ...base, kind: 'confirm', title: '继续吗？', message: '将覆盖 3 个文件' }
  expect(interactionCardOf(confirm)).toEqual({
    interactionId: 'i1',
    state: 'pending',
    interactionKind: 'confirm',
    request: { title: '继续吗？', message: '将覆盖 3 个文件' },
  })
  expect(interactionCardOf(confirm, { answer: { kind: 'confirm', value: true } })).toMatchObject({
    state: 'approved',
    response: { value: true },
  })
  expect(interactionCardOf(confirm, { answer: { kind: 'confirm', value: false } }).state).toBe('rejected')
  const [item] = itemsOf(confirm)
  expect(item).toMatchObject({
    type: 'question',
    questionId: 'i1',
    questions: [],
    dialog: { kind: 'confirm', title: '继续吗？', message: '将覆盖 3 个文件' },
  })
  expect(item?.type === 'question' ? item.resolution : 'x').toBeUndefined()
})

test('I7 单选与输入：选项原文与提示照引擎的画，答复是原文 / 那句话', () => {
  const select: Interaction = { ...base, kind: 'select', title: '用哪个？', options: ['甲', '乙'] }
  expect(interactionCardOf(select, { answer: { kind: 'select', value: '乙' } })).toEqual({
    interactionId: 'i1',
    state: 'answered',
    interactionKind: 'select',
    request: { title: '用哪个？', options: ['甲', '乙'] },
    response: { value: '乙' },
  })
  expect(itemsOf(select)[0]).toMatchObject({ type: 'question', dialog: { kind: 'select', options: ['甲', '乙'] } })

  const input: Interaction = { ...base, kind: 'input', title: '起个名', placeholder: null, multiline: false }
  expect(interactionCardOf(input)).toEqual({
    interactionId: 'i1',
    state: 'pending',
    interactionKind: 'input',
    request: { title: '起个名', multiline: false },
  })
  expect(interactionCardOf(input, { answer: { kind: 'input', value: null } })).toMatchObject({
    state: 'answered',
    response: {},
  })
  const editor: Interaction = { ...base, kind: 'input', title: '正文', placeholder: '预填', multiline: true }
  expect(itemsOf(editor)[0]).toMatchObject({
    type: 'question',
    dialog: { kind: 'input', title: '正文', placeholder: '预填', multiline: true },
  })
  /* 撤下：卡片收口成 cancelled，面板让位 */
  const [dismissed] = itemsOf(input, { kind: 'dismiss' })
  expect(dismissed?.type === 'question' ? dismissed.resolution?.outcome : 'x').toBe('cancelled')
})

test('I8 待答的单问是 awaiting_question：输入框那张卡认得到它，不再落成审批', () => {
  const select: Interaction = { ...base, kind: 'select', title: '用哪个？', options: ['甲', '乙'] }
  const projected = projectTranscript(pageWith([interactionCardOf(select)]), createProjectionMemo())
  expect(projected.status).toBe('awaiting_question')
})

test('I9 答过的题组带着调用号：锚进那次 ask 的产出，一轮问两次各归各的', () => {
  const second = [
    ...ASK_TURN,
    {
      op: 'frame.upsert',
      turnId: 't1',
      stepId: 't1:s0',
      frame: { kind: 'tool', frameId: 't1:s0:f1', toolCallId: 'call-2', name: 'ask', state: 'done', output: '第二次' },
    },
  ] as unknown as TranscriptOperation[]
  const answered = (id: string, call: string, option: string): TranscriptInteraction => ({
    ...interactionCardOf(
      { ...QUESTION, id },
      {
        answer: {
          kind: 'question',
          answers: { q0: { selected: [option], custom: null }, q1: { selected: [], custom: null } },
        },
      },
    ),
    toolCallId: call,
  })
  const projected = projectTranscript(
    pageWith([answered('g2', 'call-2', 'o1'), answered('g1', 'call-1', 'o0')], second),
    createProjectionMemo(),
  )
  const calls = [...projected.sealed, projected.active]
    .flatMap((page) => page.items)
    .filter((item) => item.type === 'tool_call')
  const text = (call: string) =>
    JSON.stringify(calls.find((item) => item.type === 'tool_call' && item.toolCallId === call))
  expect(text('call-1')).toContain('bun')
  expect(text('call-1')).not.toContain('node')
  expect(text('call-2')).toContain('node')
})
