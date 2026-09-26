/*
 * omp 的 ask 题组 ↔ 产品题组：形状折叠与答复翻译的自检。
 *
 * 断言的形状取自上游源码，不是我们自己的想象：
 * - 请求 tools/ask.ts:60-72 的 arkType；
 * - 答复 @oh-my-pi/pi-tui 的 overlays/ask-dialog（options / selectedOptions 都是标签）。
 *
 * 最重要的一条是号与标签的往返：产品的答案按号回来，上游只认标签，
 * 折错一个标签就等于替人答了另一个选项。
 *
 * 自检跑法：bun test src/__tests__/questions.test.ts
 */

import { expect, test } from 'bun:test'
import { APPROVAL_OPTIONS, approvalDetailOf, approvalToolOf } from '../approval.ts'
import { answerPayloadOf, askQuestionsOf } from '../questions.ts'

/** 上游一道真实形状的题（tools/ask.ts 的 schema 逐格对应）。 */
const UPSTREAM = [
  {
    id: 'q1',
    question: '走哪条路？',
    header: '路线',
    options: [
      { label: '甲路', description: '稳妥' },
      { label: '乙路', preview: '一段富文本预览' },
    ],
    multi: false,
    recommended: 1,
  },
  {
    id: 'q2',
    question: '要不要额外手段？',
    options: [{ label: '要' }, { label: '不要' }],
    multi: true,
  },
]

test('a readable question group folds into the product shape, ids minted here', () => {
  const asked = askQuestionsOf(UPSTREAM)

  expect(asked).toHaveLength(2)
  expect(asked[0]).toMatchObject({
    id: 'q1',
    question: '走哪条路？',
    header: '路线',
    multiSelect: false,
    // 上游恒定允许自答（tools/ask.ts:42 的 OTHER_OPTION 恒在列）。
    allowOther: true,
  })
  expect(asked[0]?.options).toEqual([
    { id: 'o0', label: '甲路', description: '稳妥' },
    // preview 产品画不出，如实不带；label 原样。
    { id: 'o1', label: '乙路' },
  ])
  expect(asked[1]).toMatchObject({ id: 'q2', multiSelect: true })
})

test('junk is dropped rather than turned into an empty question', () => {
  // 画不出一组空题：面板收到空题组会抛（question-panel 的 `收到一组空题`）。
  expect(askQuestionsOf(undefined)).toEqual([])
  expect(askQuestionsOf([{ id: 'x' }])).toEqual([])
  expect(askQuestionsOf([{ question: '有题没 id' }])).toHaveLength(1)
})

test('an unanswered question drops its unreadable options instead of inventing labels', () => {
  const asked = askQuestionsOf([
    {
      id: 'q1',
      question: '题',
      options: [{ description: '没有标签' }, 'not an object', { label: '好' }],
    },
  ])

  expect(asked[0]?.options).toEqual([{ id: 'o0', label: '好' }])
})

test('a single-choice answer comes back as the upstream label, not our id', () => {
  const asked = askQuestionsOf(UPSTREAM)
  const payload = answerPayloadOf(asked, {
    answers: {
      q1: { kind: 'single', optionId: 'o1' },
      q2: { kind: 'multi', optionIds: ['o0'] },
    },
  })

  // 上游只认标签（ask.ts 收下之后按标签回显）。
  expect(payload).toEqual({
    kind: 'submit',
    results: [
      {
        id: 'q1',
        question: '走哪条路？',
        options: ['甲路', '乙路'],
        multi: false,
        selectedOptions: ['乙路'],
      },
      {
        id: 'q2',
        question: '要不要额外手段？',
        options: ['要', '不要'],
        multi: true,
        selectedOptions: ['要'],
      },
    ],
  })
})

test('a written answer rides as customInput alongside the picked labels', () => {
  const asked = askQuestionsOf(UPSTREAM)
  const payload = answerPayloadOf(asked, {
    answers: {
      q1: { kind: 'multi_with_other', optionIds: ['o0'], otherText: '都不满意' },
      q2: { kind: 'skipped' },
    },
  })

  expect(payload?.results[0]).toMatchObject({ selectedOptions: ['甲路'], customInput: '都不满意' })
  // 跳过在单选里折成空选：上游对单选把「一个都没选」读成取消（ask.ts:984-992），
  // 对多选则是合法的「一个都不选」。产品表达不了这个分野，如实照送。
  expect(payload?.results[1]).toMatchObject({ selectedOptions: [] })
})

test('the group note rides once, on the first question', () => {
  const asked = askQuestionsOf(UPSTREAM)
  const payload = answerPayloadOf(asked, {
    answers: { q1: { kind: 'single', optionId: 'o0' }, q2: { kind: 'multi', optionIds: [] } },
    note: '  整体一句话  ',
  })

  // 上游的 note 是每题一格，产品的是整组一格：挂一次，免得在模型上下文里重复。
  expect(payload?.results[0]?.note).toBe('整体一句话')
  expect(payload?.results[1]?.note).toBeUndefined()
})

test('a question group is not also reported as a raw dialog', () => {
  /*
   * 题组有自己那一条 `questions_asked`（产品形状）；同一件事再发一条原样的
   * `dialog_requested` 就是两条路说一件事，下游必然筛两遍。
   *
   * 上面那条由 DialogDesk 的出口收窄（main.ts 的 adopt），Rust 侧同名的
   * `an_ask_dialog_is_not_also_reported_as_a_raw_dialog` 钉的是另一半。
   * 这里钉判据本身：认这一次收窄只看 method，不看别的格。
   */
  expect(
    askQuestionsOf([{ id: 'q0', question: '选一个', options: [{ label: '甲' }] }]),
  ).toHaveLength(1)
  // 一道都认不出时上层不报：空题组会让面板抛（question-panel 的 `收到一组空题`）。
  expect(askQuestionsOf([])).toEqual([])
})

test('nothing answered is undefined, which upstream reads as a cancellation', () => {
  const asked = askQuestionsOf(UPSTREAM)

  // 撤下整组：产品送来空答案表。
  expect(answerPayloadOf(asked, { answers: {} })).toBeUndefined()
  expect(answerPayloadOf(asked, null)).toBeUndefined()
  // 少答一题也不成交 —— 上游会因为题数不匹配而抛（ask.ts:951-956）。
  expect(
    answerPayloadOf(asked, { answers: { q1: { kind: 'single', optionId: 'o0' } } }),
  ).toBeUndefined()
  // 认不出的号：宁可当作没答，也不替人挑一个。
  expect(
    answerPayloadOf(asked, {
      answers: { q1: { kind: 'single', optionId: '不存在' }, q2: { kind: 'skipped' } },
    }),
  ).toBeUndefined()
})

/*
 * 授权那一次对话框：判据、工具名、以及「将做什么」。
 *
 * 标题是上游 tools/approval.ts 的 formatApprovalPrompt 拼出来的原文，形状固定：
 * 第一行 `Allow tool: <name>`，其后是工具自报的细节。这里逐字照抄那个形状，
 * 因为两侧（我们与 Rust 的 approval_of）都靠它认这一次对话框。
 */
const APPROVAL_TITLE = ['Allow tool: bash', 'Command: rm -rf build'].join('\n')

test('an approval dialog is recognised by its option set, and yields the tool name', () => {
  const request = { method: 'select', title: APPROVAL_TITLE, options: [...APPROVAL_OPTIONS] }

  expect(approvalToolOf(request)).toBe('bash')
})

test('what the tool will actually do rides along — the tool name alone answers nothing', () => {
  const request = { method: 'select', title: APPROVAL_TITLE, options: [...APPROVAL_OPTIONS] }

  // 「要不要允许 Bash」回答不了任何问题；人要知道的是将跑哪条命令。
  expect(approvalDetailOf(request)).toBe('Command: rm -rf build')
})

test('a dialog that is not the approval gate is not mistaken for one', () => {
  // 选项集不对：这是普通 select，不是闸门（上游靠选项集区分，没有独立 method）。
  expect(approvalToolOf({ method: 'select', title: 'Which one?', options: ['a', 'b'] })).toBeNull()
  expect(approvalToolOf({ method: 'confirm', title: APPROVAL_TITLE })).toBeNull()
  expect(approvalToolOf({})).toBeNull()
  // 认不出工具名时交出空串而不是编一个：那一格只用于说法与设置键，编一个就是撒谎。
  expect(approvalToolOf({ method: 'select', options: [...APPROVAL_OPTIONS] })).toBe('')
})

test('an approval with no detail line prints nothing, it does not invent one', () => {
  const bare = { method: 'select', title: 'Allow tool: read', options: [...APPROVAL_OPTIONS] }

  // `Allow tool:` 之后空无一字：没有细节可说，如实缺席而不是编一句。
  expect(approvalDetailOf(bare)).toBeNull()
})

test('a title that is itself the thing being approved prints whole', () => {
  /*
   * 计划提交那一类没有 `Allow tool:` 行（整句标题就是要批准的东西）。调用方已经先验过
   * 它确实是这次闸门，所以这里整句就是细节 —— 丢掉它等于把带子变成一句没有内容的确认。
   */
  expect(approvalDetailOf({ method: 'select', title: '计划待批准：重构输入层' })).toBe(
    '计划待批准：重构输入层',
  )
})
