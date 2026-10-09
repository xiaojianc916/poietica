import { describe, expect, test } from 'bun:test'
import { approvalDetailOf, approvalOf, approvalToolOf } from '../approval'
import { planInteraction, planOutcomeOf } from '../plan'
import { askQuestionsOf, askResultOf } from '../questions'

/*
 * omp 的 ask 题组 ↔ 产品题组：形状折叠与答复翻译的自检。
 *
 * 迁移自 legacy questions.test.ts（题组与审批那两部分）与 answer-parity.test.ts，
 * 断言意图一条不删，只把输入改成新接口（12 页 §12.3 的去向表）。
 * 断言的形状取自上游源码：请求是 tools/ask.ts:770-784 的 ExtensionAskDialogQuestion；
 * 答复是 pi-tui/overlays/ask-dialog 的 results（options / selectedOptions 都是标签）。
 *
 * 最重要的一条是号与标签的往返：产品的答案按号回来，上游只认标签，
 * 折错一个标签就等于替人答了另一个选项。
 */

/**
 * 上游的答复类型是判别联合（kind: 'submit' | 'chat'）：断言只关心 submit 那一支，
 * 取不到就当场抛错 —— 静默返回 undefined 会让断言变成假绿。
 */
function submitOf(result: ReturnType<typeof askResultOf>) {
  if (result === undefined) throw new Error('应当得到答复，实际是「没答」')
  if (result.kind !== 'submit') throw new Error(`应当得到 submit 答复，实际是 ${result.kind}`)
  return result
}

/** 上游一组真实形状的题（tools/ask.ts 的 schema 逐格对应） */
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

describe('题组折叠', () => {
  test('认得出的题组折成产品形状，号由这里签发', () => {
    const asked = askQuestionsOf(UPSTREAM)

    expect(asked).toHaveLength(2)
    expect(asked[0]).toMatchObject({
      id: 'q1',
      prompt: '走哪条路？',
      multiple: false,
      // 上游恒定允许自答（tools/ask.ts 的 OTHER_OPTION 恒在列）
      allowCustom: true,
    })
    expect(asked[0]?.options).toEqual([
      { id: 'o0', label: '甲路', description: '稳妥' },
      // preview 与 recommended 产品画不出，如实不带；label 原样
      { id: 'o1', label: '乙路', description: null },
    ])
    expect(asked[1]).toMatchObject({ id: 'q2', multiple: true })
  })

  test('认不出的东西如实丢掉，不编一道空题', () => {
    // 画不出一组空题：面板收到空题组会抛
    expect(askQuestionsOf([])).toEqual([])
    expect(askQuestionsOf([{ id: 'x' }])).toEqual([])
    expect(askQuestionsOf([{ question: '有题没 id' }])).toHaveLength(1)
    expect(askQuestionsOf([null, 'not an object', 3])).toEqual([])
    // 一道都认不出时上层不报：空题组会让提问面板无从画起
    expect(askQuestionsOf([{ id: 'q0', question: '选一个', options: [{ label: '甲' }] }])).toHaveLength(1)
  })

  test('认不出的选项被丢掉，号上不留洞', () => {
    const asked = askQuestionsOf([
      {
        id: 'q1',
        question: '题',
        options: [{ description: '没有标签' }, 'not an object', { label: '好' }],
      },
    ])

    expect(asked[0]?.options).toEqual([{ id: 'o0', label: '好', description: null }])
  })
})

describe('答复翻译', () => {
  test('单选题的答复折回上游的标签，而不是我们的号', () => {
    const asked = askQuestionsOf(UPSTREAM)
    const payload = askResultOf(asked, {
      answers: {
        q1: { selected: ['o1'], custom: null },
        q2: { selected: ['o0'], custom: null },
      },
    })

    // 上游只认标签（ask.ts 收下之后按标签回显）
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

  test('自己写的答案与勾选的标签同行', () => {
    const asked = askQuestionsOf(UPSTREAM)
    const payload = askResultOf(asked, {
      answers: {
        q1: { selected: ['o0'], custom: '都不满意' },
        q2: { selected: [], custom: null },
      },
    })

    expect(submitOf(payload).results[0]).toMatchObject({ selectedOptions: ['甲路'], customInput: '都不满意' })
    // 跳过在单选里折成空选：上游对单选把「一个都没选」读成取消（ask.ts:835-841），
    // 对多选则是合法的「一个都不选」。产品表达不了这个分野，如实照送。
    expect(submitOf(payload).results[1]).toMatchObject({ selectedOptions: [] })
  })

  test('整组备注只出现一次，挂在第一题上', () => {
    const asked = askQuestionsOf(UPSTREAM)
    const payload = askResultOf(asked, {
      answers: { q1: { selected: ['o0'], custom: null }, q2: { selected: [], custom: null } },
      note: '  整体一句话  ',
    })

    // 上游的 note 是每题一格，产品的是整组一格：挂一次，免得在模型上下文里重复
    expect(submitOf(payload).results[0]?.note).toBe('整体一句话')
    expect(submitOf(payload).results[1]?.note).toBeUndefined()
  })

  test('没答就是 undefined，上游把它读成取消', () => {
    const asked = askQuestionsOf(UPSTREAM)

    // 撤下整组：产品送来空答案表
    expect(askResultOf(asked, { answers: {} })).toBeUndefined()
    expect(askResultOf(asked, null)).toBeUndefined()
    // 少答一题也不成交 —— 上游会因为题数不匹配而抛（ask.ts:802-813）
    expect(askResultOf(asked, { answers: { q1: { selected: ['o0'], custom: null } } })).toBeUndefined()
    // 认不出的号：宁可当作没答，也不替人挑一个
    expect(
      askResultOf(asked, {
        answers: { q1: { selected: ['不存在'], custom: null }, q2: { selected: [], custom: null } },
      }),
    ).toBeUndefined()
  })
})

/*
 * 一条答复的两个半边必须对得上：产品序列化出去的那份，正是这里读进来折成上游 results 的那份。
 * 这条缝是最容易错的地方 —— 两侧各自单测全绿，接起来却发现号对不上。
 * 下面几份载荷是有意写死的 JSON 字面量（legacy answer-parity 的意图：不信构造器，只信线上那份文本）。
 */
const ASKED = askQuestionsOf([
  { id: 'q0', question: '选一个', options: [{ label: '甲' }, { label: '乙' }], multi: false },
])

describe('答复往返（迁移自 answer-parity）', () => {
  test('每一种答复形状都是这里读得懂的', () => {
    // 单选的号必须折回标签 —— 上游只认标签
    expect(
      submitOf(askResultOf(ASKED, JSON.parse('{"answers":{"q0":{"selected":["o1"],"custom":null}}}'))).results[0],
    ).toMatchObject({
      selectedOptions: ['乙'],
    })
    expect(
      submitOf(askResultOf(ASKED, JSON.parse('{"answers":{"q0":{"selected":["o0","o1"],"custom":null}}}'))).results[0],
    ).toMatchObject({
      selectedOptions: ['甲', '乙'],
    })
    // 自答走 customInput，与勾选可以是同一题的两半
    expect(
      submitOf(askResultOf(ASKED, JSON.parse('{"answers":{"q0":{"selected":[],"custom":"都不合适"}}}'))).results[0],
    ).toMatchObject({
      selectedOptions: [],
      customInput: '都不合适',
    })
    expect(
      submitOf(askResultOf(ASKED, JSON.parse('{"answers":{"q0":{"selected":["o0"],"custom":"再加一点"}}}'))).results[0],
    ).toMatchObject({
      selectedOptions: ['甲'],
      customInput: '再加一点',
    })
    // 跳过折成空选（上游对单选读成取消，对多选读成「一个都不选」）
    expect(
      submitOf(askResultOf(ASKED, JSON.parse('{"answers":{"q0":{"selected":[],"custom":null}}}'))).results[0],
    ).toMatchObject({
      selectedOptions: [],
    })
    // 备注与作答方式不影响题面，可以同行
    expect(
      submitOf(
        askResultOf(ASKED, JSON.parse('{"answers":{"q0":{"selected":["o0"],"custom":null}},"note":"整组一句话"}')),
      ).results[0]?.note,
    ).toBe('整组一句话')
    expect(
      submitOf(askResultOf(ASKED, JSON.parse('{"answers":{"q0":{"selected":["o0"],"custom":null}},"method":"click"}')))
        .results[0]?.id,
    ).toBe('q0')
  })

  test('撤下整组就是空答案表，含义是「没答」', () => {
    expect(askResultOf(ASKED, JSON.parse('{"answers":{}}'))).toBeUndefined()
  })

  test('题里从没给过的选项号被拒绝，不替人猜', () => {
    // 号对不上时宁可当作没答：替人挑一枚就是替他做了决定
    expect(askResultOf(ASKED, JSON.parse('{"answers":{"q0":{"selected":["o9"],"custom":null}}}'))).toBeUndefined()
  })
})

/*
 * 授权那一次对话框：判据、工具名、以及「将做什么」。
 *
 * 标题是上游 tools/approval.ts 的 formatApprovalPrompt 拼出来的原文，形状固定：
 * 第一行 Allow tool: <name>，其后是工具自报的细节。这里逐字照抄那个形状。
 */
const APPROVAL_TITLE = ['Allow tool: bash', 'Command: rm -rf build'].join('\n')

describe('授权闸门的识别（迁移自 questions.test.ts）', () => {
  test('选项集认出这一次授权，并交出工具名', () => {
    expect(approvalOf(APPROVAL_TITLE, ['Approve', 'Deny'])?.tool).toBe('bash')
    // 次序无关：认的是选项集，不是按钮的位置
    expect(approvalOf(APPROVAL_TITLE, ['Deny', 'Approve'])?.tool).toBe('bash')
  })

  test('工具将要做的那件事随行 —— 只说工具名回答不了任何问题', () => {
    // 「要不要允许 Bash」回答不了任何问题；人要知道的是将跑哪条命令
    expect(approvalOf(APPROVAL_TITLE, ['Approve', 'Deny'])?.detail).toBe('Command: rm -rf build')
    expect(approvalDetailOf(APPROVAL_TITLE)).toBe('Command: rm -rf build')
  })

  test('不是闸门的对话框不会被误认', () => {
    // 选项集不对：这是普通 select，不是闸门（上游靠选项集区分，没有独立 method）
    expect(approvalOf('Which one?', ['a', 'b'])).toBeNull()
    expect(approvalOf('Which one?', ['Approve'])).toBeNull()
    expect(approvalOf('Which one?', ['Approve', 'Deny', 'Other'])).toBeNull()
    // 没有 Allow tool: 行的（计划提交那类）不是工具授权
    expect(approvalOf('计划待批准：重构输入层', ['Approve', 'Deny'])).toBeNull()
    expect(approvalToolOf('计划待批准：重构输入层')).toBeNull()
  })

  test('认不出工具名就是不认，不编一个', () => {
    // 那一格只用于说法与设置键，编一个就是撒谎
    expect(approvalToolOf('Allow tool:')).toBeNull()
    expect(approvalToolOf('Allow tool:   ')).toBeNull()
    expect(approvalOf('Allow tool:', ['Approve', 'Deny'])).toBeNull()
  })

  test('没有细节那一行就不印，不编一句', () => {
    // Allow tool: 之后空无一字：没有细节可说，如实缺席而不是编一句
    expect(approvalDetailOf('Allow tool: read')).toBeNull()
    // 标题本身就是被批准的东西：整句都要印出来，丢掉它等于把带子变成一句没有内容的确认
    expect(approvalDetailOf('计划待批准：重构输入层')).toBe('计划待批准：重构输入层')
  })
})

describe('计划（12 页 §8.5）', () => {
  test('计划提交折成 plan 交互，正文原样带上', () => {
    expect(planInteraction({ title: '重构输入层', planFilePath: 'local://input-plan.md', markdown: '# 计划' })).toEqual(
      {
        kind: 'plan',
        title: '重构输入层',
        planFilePath: 'local://input-plan.md',
        planMarkdown: '# 计划',
      },
    )
  })

  test('答复折成批准 / 作废 / 让它改', () => {
    expect(planOutcomeOf({ kind: 'plan', decision: 'approve', feedback: null })).toEqual({
      decision: 'approve',
      feedback: null,
    })
    expect(planOutcomeOf({ kind: 'plan', decision: 'reject', feedback: '方向不对' })).toEqual({
      decision: 'reject',
      feedback: '方向不对',
    })
    expect(planOutcomeOf({ kind: 'plan', decision: 'revise', feedback: '  补上回滚方案  ' })).toEqual({
      decision: 'revise',
      feedback: '补上回滚方案',
    })
    // 说了要改却一个字没给：按作废处理，不把空话回给模型
    expect(planOutcomeOf({ kind: 'plan', decision: 'revise', feedback: '   ' })).toEqual({
      decision: 'reject',
      feedback: null,
    })
    // 没人答（超时 / 中止 / 取消一轮）：没人批就是不批，但仍留在计划模式里
    expect(planOutcomeOf({ kind: 'dismiss' })).toEqual({ decision: 'reject', feedback: null })
  })
})
