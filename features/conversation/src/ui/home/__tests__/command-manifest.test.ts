import { describe, expect, test } from 'bun:test'
import type { SlashCommand } from '@poietica/engine'
import type { SlashCommandContribution } from '../../../ui-api'
import type { SessionConfigControl } from '../../shared/model/config'
import { availableCommands, type CommandContext, resolveCommand } from '../command-manifest'

const engine = (name: string, extra: Partial<SlashCommand> = {}): SlashCommand => ({
  name,
  aliases: [],
  description: null,
  hint: null,
  source: 'builtin',
  subcommands: [],
  ...extra,
})

/* omp 表里的一部分：GUI 接的、GUI 不接的、用户写的 */
const ENGINE: readonly SlashCommand[] = [
  engine('compact'),
  engine('fast'),
  engine('retry'),
  engine('review'),
  engine('ssh'),
  engine('changelog'),
  engine('mcp'),
  engine('deploy', { source: 'file', description: '部署到预发', hint: '<环境>' }),
  engine('lint-fix', { source: 'extension' }),
]

const MODEL: SessionConfigControl = {
  id: 'model',
  label: '模型',
  purpose: 'model',
  current: 'anthropic/opus',
  choices: [
    { value: 'anthropic/opus', label: 'Claude Opus' },
    { value: 'openai/gpt', label: 'GPT' },
  ],
}

const MCP: SlashCommandContribution = { name: 'mcp', description: '打开 MCP 设置', order: 100, run: () => undefined }

const context = (extra: Partial<CommandContext> = {}): CommandContext => ({
  place: 'idle',
  engine: ENGINE,
  contributed: [MCP],
  controls: [MODEL],
  status: 'ready',
  can: { rename: true, export: true, share: true, context: true, todo: true },
  ...extra,
})

const names = (ctx: CommandContext): string[] => availableCommands(ctx).map((command) => command.name)

describe('面板列哪些命令', () => {
  test('对话空闲：清单里能用的 + 贡献的 + 用户写的；GUI 不接的（/ssh、/changelog）不列', () => {
    const listed = names(context())
    expect(listed).toContain('compact')
    expect(listed).toContain('fast')
    expect(listed).toContain('model')
    expect(listed).toContain('mcp')
    expect(listed).toContain('deploy')
    expect(listed).not.toContain('ssh')
    expect(listed).not.toContain('changelog')
  })

  test('入口页：要会话的（/compact、/fast、/new、/fork）不列；切模型、计划、工作流、用户命令照列', () => {
    const listed = names(context({ place: 'draft' }))
    for (const name of ['compact', 'fast', 'new', 'fork', 'rename']) expect(listed).not.toContain(name)
    for (const name of ['model', 'review', 'deploy', 'mcp', 'settings']) expect(listed).toContain(name)
  })

  test('agent 正在回复：只列不经 omp 的（引擎非空闲不收命令）', () => {
    const listed = names(context({ place: 'busy' }))
    expect(listed).not.toContain('compact')
    expect(listed).not.toContain('review')
    expect(listed).not.toContain('deploy')
    expect(listed).toContain('model')
    expect(listed).toContain('mcp')
    expect(listed).toContain('rename')
  })

  test('/retry 只在上一轮失败或被打断后列', () => {
    expect(names(context())).not.toContain('retry')
    expect(names(context({ status: 'error' }))).toContain('retry')
    expect(names(context({ status: 'interrupted' }))).toContain('retry')
  })

  test('omp 表里没有的引擎命令不列（omp 关掉某条时不画一个点了没反应的入口）', () => {
    expect(names(context({ engine: [] }))).not.toContain('compact')
  })

  test('按用途分组排序；用户写的命令归「自定义命令」「扩展命令」，必填参数取自 omp 的提示', () => {
    const listed = availableCommands(context())
    const groups = [...new Set(listed.map((command) => command.group))]
    expect(groups).toEqual(['conversation', 'mode', 'model', 'workflow', 'settings', 'custom', 'extension'])
    const deploy = listed.find((command) => command.name === 'deploy')
    expect(deploy?.input).toEqual({ kind: 'text', required: true, placeholder: '环境' })
    expect(listed.find((command) => command.name === 'lint-fix')?.group).toBe('extension')
  })

  test('/model 的二级选项就是模型选择器那张表，勾着当前模型', () => {
    const model = availableCommands(context()).find((command) => command.name === 'model')
    expect(model?.input).toEqual({
      kind: 'choice',
      choices: [
        { value: 'anthropic/opus', label: 'Claude Opus' },
        { value: 'openai/gpt', label: 'GPT' },
      ],
      current: 'anthropic/opus',
    })
    expect(model?.aliases).toContain('switch')
  })

  test('贡献的命令与 omp 同名时以贡献为准（/mcp 打开设置页）', () => {
    const mcp = availableCommands(context()).filter((command) => command.name === 'mcp')
    expect(mcp).toHaveLength(1)
    expect(mcp[0]?.effect.kind).toBe('contributed')
  })
})

describe('手打的命令落到哪儿', () => {
  test('能用的：ready；别名也认', () => {
    expect(resolveCommand('switch', context())).toMatchObject({ kind: 'ready', command: { name: 'model' } })
    expect(resolveCommand('compact', context())).toMatchObject({
      kind: 'ready',
      command: { effect: { kind: 'engine' } },
    })
  })

  test('清单里有、此刻不能用：blocked，并说为什么', () => {
    expect(resolveCommand('compact', context({ place: 'draft' }))).toEqual({
      kind: 'blocked',
      reason: '/compact 要在对话里用：先发出第一句话',
    })
    expect(resolveCommand('compact', context({ place: 'busy' }))).toEqual({
      kind: 'blocked',
      reason: '/compact agent 正在回复：等这一轮结束（或先停止）再用',
    })
    expect(resolveCommand('retry', context())).toEqual({ kind: 'blocked', reason: '上一轮没有失败，不需要重试' })
  })

  test('用户写的命令在 agent 跑着时：blocked', () => {
    expect(resolveCommand('deploy', context({ place: 'busy' }))).toMatchObject({ kind: 'blocked' })
  })

  test('omp 有、GUI 不提供：hidden（不当一句话发给模型）', () => {
    expect(resolveCommand('ssh', context())).toEqual({ kind: 'hidden', name: 'ssh' })
    expect(resolveCommand('changelog', context())).toEqual({ kind: 'hidden', name: 'changelog' })
  })

  test('谁都不认识的：null，照常当一句话发', () => {
    expect(resolveCommand('usr', context())).toBeNull()
  })
})
