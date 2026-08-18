import type { PermissionItem } from '@poietica/agent'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PermissionDock } from '../composer/permission-dock'
import { type AgentDialect, AgentDialectContext } from '../semantics/agent-dialect'
import { isQuestionRequest } from '../semantics/ask-user-question'
import { PermissionRecord } from '../timeline/permission-record'

/*
 * 提问闸门。
 *
 * ACP 没有「提问」这个概念，一道题在 wire 上就是一个 session/request_permission。
 * 于是有人必须当场判断：这一帧该画成一道题，还是画成一次授权。判错的方向不
 * 对称 —— 把授权误判成提问，用户以为自己在挑选项，实际是在批准写盘。
 * ask-user-question.ts 的注释写明了这个风险，这个文件负责守住它。
 *
 * 审批搬到输入框上之后，闸门不再是一个组件里的一个 if，而是三处：
 *
 *   isQuestionRequest   判据本身，只看 optionId 形状加 ACP kind
 *   PermissionRecord    转录侧：提问留一张结果卡，授权一个字不留
 *   PermissionDock      输入框侧：授权出胶囊按钮
 *
 * 所以危险输入要在三处同时钉住 —— 拆开之后，任何一处单独漏判都足以让它漏过去。
 *
 * 方言在这里就地写死，不从 packages/agent-registry 取：界面层不认识任何一家
 * agent，测试也不该反过来把这条依赖引进来。它只需要一份形状对的方言。
 */

const DIALECT: AgentDialect = {
  optionLabels: { Skip: '跳过' },
  questions: [{ option: /^q(\d+)_opt_(\d+)$/, skip: /^q(\d+)_skip$/ }],
}

/**
 * 一道题。
 *
 * title 写死成工具名是上游的实际发法，题面在 toolCall.content 里 —— 这不是
 * 夹具偷懒，是 wire 上就长这样，readQuestionPrompt 的取值路径正因此而存在。
 */
function question(resolution?: PermissionItem['resolution']): PermissionItem {
  const base = {
    type: 'permission',
    id: 'item-question',
    at: 0,
    turn: 0,
    requestId: 'req-question',
    title: 'AskUserQuestion',
    toolCall: {
      toolCallId: '0:ask_0',
      content: [{ type: 'content', content: { type: 'text', text: '这一版用哪种配色？' } }],
    },
    options: [
      { optionId: 'q0_opt_0', name: '深色', kind: 'allow_once' },
      { optionId: 'q0_opt_1', name: '浅色', kind: 'allow_once' },
      { optionId: 'q0_skip', name: 'Skip', kind: 'reject_once' },
    ],
  } as const satisfies Omit<PermissionItem, 'resolution'>

  return resolution === undefined ? base : { ...base, resolution }
}

/**
 * 一次授权，optionId 却恰好落在提问的命名空间里。
 *
 * 这是闸门唯一真正危险的输入：形状全对，只有 kind 出卖了它 —— 一道题里不会
 * 出现 allow_always，因为「以后都这么答」对提问没有意义。
 */
function consent(): PermissionItem {
  return {
    type: 'permission',
    id: 'item-consent',
    at: 0,
    turn: 0,
    requestId: 'req-consent',
    title: 'write',
    options: [
      { optionId: 'q0_opt_0', name: '写入', kind: 'allow_once' },
      { optionId: 'q0_opt_1', name: '始终写入', kind: 'allow_always' },
    ],
  }
}

/** 转录侧。 */
function record(item: PermissionItem): string {
  return renderToStaticMarkup(
    <AgentDialectContext value={DIALECT}>
      <PermissionRecord item={item} />
    </AgentDialectContext>,
  )
}

/** 输入框侧。 */
function dock(item: PermissionItem): string {
  return renderToStaticMarkup(
    <AgentDialectContext value={DIALECT}>
      <PermissionDock call={undefined} item={item} onResolve={() => {}} waiting={1} />
    </AgentDialectContext>,
  )
}

describe('提问闸门', () => {
  it('形状与 kind 都对得上,转录里留一张题卡', () => {
    const markup = record(question())

    expect(markup).toContain('assistant-outcome')
    expect(markup).toContain('等待回答…')
  })

  it('题面取自 toolCall 里的那段文本,不是写死的工具名', () => {
    const markup = record(question())

    expect(markup).toContain('这一版用哪种配色？')
    expect(markup).not.toContain('AskUserQuestion')
  })

  it('答过之后只留被选中的那一个,落选项不再露面', () => {
    const markup = record(question({ optionId: 'q0_opt_1', outcome: 'selected' }))

    expect(markup).toContain('assistant-outcome__answer')
    expect(markup).toContain('浅色')
    expect(markup).not.toContain('深色')
  })

  it('跳过不算答案,底下一句话交代', () => {
    const markup = record(question({ optionId: 'q0_skip', outcome: 'selected' }))

    expect(markup).not.toContain('assistant-outcome__answer')
    expect(markup).toContain('已跳过，未回答')
    expect(markup).not.toContain('Skip')
  })

  it('形状对但 kind 是长期授权的,判据一票否决', () => {
    expect(isQuestionRequest(consent(), DIALECT.questions)).toBe(false)
    expect(isQuestionRequest(question(), DIALECT.questions)).toBe(true)
  })

  it('那次授权走审批带,转录里一个字不留', () => {
    expect(record(consent())).toBe('')

    const bar = dock(consent())

    expect(bar).toContain('assistant-approval__options')
    expect(bar).toContain('始终写入')
    expect(bar).not.toContain('assistant-outcome')
  })
})
