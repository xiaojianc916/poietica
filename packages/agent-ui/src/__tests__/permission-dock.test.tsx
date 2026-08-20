import type { PermissionItem, ToolCallTimelineItem } from '@poietica/agent'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PermissionDock } from '../composer/permission-dock'
import { type AgentDialect, AgentDialectContext } from '../semantics/agent-dialect'

/*
 * 审批带是唯一会把 agent 卡住、非等用户点一下不可的界面，因此它显示错字的代价
 * 比别处都高：用户是照着按钮上的字决定要不要放行的。
 *
 * 用 react-dom/server 而不是 testing-library：要守的都只关乎一次渲染的产物，
 * 不需要 DOM，也就不需要为此往这个包里添三个依赖和一套环境配置。
 */

/** 一家 agent 的说法。刻意让两枚选项同 kind、不同 name。 */
const DIALECT: AgentDialect = {
  optionLabels: {
    'Approve once': '批准一次',
    'Approve for this session': '本次会话都批准',
    Reject: '拒绝',
  },
}

function permission(overrides: Partial<PermissionItem> = {}): PermissionItem {
  return {
    type: 'permission',
    id: 'r0-permission-1',
    at: 0,
    turn: 0,
    requestId: 'request-1',
    title: 'write',
    options: [
      { optionId: 'approve_once', name: 'Approve once', kind: 'allow_once' },
      { optionId: 'approve_always', name: 'Approve for this session', kind: 'allow_once' },
      { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
    ],
    ...overrides,
  }
}

/* 运行时由 pendingPermissionCall 按号取回条目；这里照同一形状造一条。 */
function callOf(item: PermissionItem): ToolCallTimelineItem | undefined {
  const asked = item.toolCall

  if (asked === undefined) {
    return undefined
  }

  return {
    type: 'tool_call',
    subject: '',
    id: `tool-${asked.toolCallId}`,
    turn: 1,
    at: 0,
    toolCallId: asked.toolCallId,
    title: item.title,
    kind: asked.kind ?? 'other',
    status: asked.status ?? 'pending',
    requestContent: [],
    content: asked.content ?? [],
    locations: asked.locations ?? [],
    startedAt: 0,
    ...(asked.rawInput === undefined ? {} : { rawInput: asked.rawInput }),
  }
}

function render(item: PermissionItem, waiting = 1): string {
  return renderToStaticMarkup(
    <AgentDialectContext value={DIALECT}>
      <PermissionDock call={callOf(item)} item={item} onResolve={() => {}} waiting={waiting} />
    </AgentDialectContext>,
  )
}

describe('审批带', () => {
  it('没有 context 就当场抛，不带着错文案画出来', () => {
    /*
     * 缺表时宁可炸在测试里，也不能悄悄套用另一家 agent 的说法。
     *
     * 咬 context 的名字而不是消息里那句话：名字是真实符号，下一次改名先由
     * typecheck 拦住；咬散文的话，一次改名会经由一个字符串把这条断言打红。
     */
    expect(() =>
      renderToStaticMarkup(
        <PermissionDock call={undefined} item={permission()} onResolve={() => {}} waiting={1} />,
      ),
    ).toThrow(/没有 AgentDialectContext/)
  })

  it('同一个 kind 的两枚选项，显示的是各自的字', () => {
    /* 按 kind 查表时这两枚都是 allow_once，会写着同一个词。按 name 才分得开。 */
    const markup = render(permission())

    expect(markup).toContain('批准一次')
    expect(markup).toContain('本次会话都批准')
    expect(markup).toContain('拒绝')
  })

  it('表里没有的说法，照 agent 原文显示', () => {
    /* 宁可显示英文，也不能显示一个错的中文。 */
    const markup = render(
      permission({
        options: [{ optionId: 'plan_revise', name: 'Revise', kind: 'reject_once' }],
      }),
    )

    expect(markup).toContain('Revise')
  })

  it('题面是 agent 送来的那一句，一个字不加', () => {
    /*
     * 这一条守的是「不替 agent 说话」。此前这里会拼一句自己的复述，于是同一次
     * 调用在带子上和工具卡里叫两个名字。
     */
    const markup = render(permission())

    expect(markup).toContain('>write</span>')
    expect(markup).not.toContain('需要批准')
  })

  it('只有一个在等就不报序号，有第二个才报', () => {
    /* 分子恒是 1（永远交出最早那一个），所以 1/1 是一句废话。 */
    expect(render(permission())).not.toContain('assistant-approval__count')
    expect(render(permission(), 3)).toContain('1/3')
  })

  it('放行只涂一颗', () => {
    /*
     * kimi 一次送来两颗 allow_once。两颗都涂，人看不出默认动作是哪一个 ——
     * agent 把它想要的那个排在前面。
     */
    const markup = render(permission())

    expect(markup.match(/data-lead="true"/g)).toHaveLength(1)
  })

  it('说得出要批准的那件事，不是只有一个工具名', () => {
    /*
     * 上游在 ACP 边界上把 command 类的 displayBlock 一律丢掉（见 tool-intent），
     * 送到这里的 title 只剩 "Bash"。人要放行的是那条命令，不是那两个字。
     */
    const markup = render(
      permission({
        title: 'Bash',
        toolCall: { toolCallId: 'call-1', rawInput: { command: 'pnpm check' } },
      }),
    )

    expect(markup).toContain('pnpm check')
  })

  it('认不出的入参形状，也要把原文端上来', () => {
    /*
     * tool-intent 认的那几个键是某一家 agent 的入参约定（见那个文件的头注释）。换
     * 一家、或者同一家换一个工具，键名就不在表里 —— 那时候仍然不能只给一个工具名
     * 让人签字。
     */
    const markup = render(
      permission({
        title: 'Bash',
        toolCall: { toolCallId: 'call-2', rawInput: { shell: 'ls ~/.kimi/skills/ 2>&1' } },
      }),
    )

    expect(markup).toContain('ls ~/.kimi/skills/')
  })
})
