import { describe, expect, test } from 'bun:test'
import type { SlashCommand } from '@poietica/engine'
import {
  type CommandChoice,
  type ComposerCommand,
  commandArgsOf,
  commandNameOf,
  matchCommand,
  rankChoices,
  rankCommands,
  slashStateOf,
} from '../commands'

const command = (name: string, extra: Partial<ComposerCommand> = {}): ComposerCommand => ({
  name,
  aliases: [],
  description: '',
  group: 'conversation',
  input: { kind: 'none' },
  ...extra,
})

/* 斜杠面板只在「整份草稿是一行、行首 `/`」时出来；已经敲了空格就进参数阶段，换行、句中斜杠都不是命令。 */
describe('草稿此刻是哪一段斜杠输入', () => {
  test('刚敲下斜杠、敲了半截名字：还在敲名字', () => {
    expect(slashStateOf('/')).toEqual({ name: '', rest: null })
    expect(slashStateOf('/comp')).toEqual({ name: 'comp', rest: null })
  })

  test('名字后敲了空格：进参数阶段，rest 是空格之后那一截', () => {
    expect(slashStateOf('/model ')).toEqual({ name: 'model', rest: '' })
    expect(slashStateOf('/compact 只保留结论')).toEqual({ name: 'compact', rest: '只保留结论' })
  })

  test('换行、句中斜杠、行首空白：不是斜杠输入', () => {
    expect(slashStateOf('/compact\n')).toBeNull()
    expect(slashStateOf('看一下 /usr/bin')).toBeNull()
    expect(slashStateOf(' /compact')).toBeNull()
  })
})

describe('一句话点名的命令与参数', () => {
  test('名字到空白或冒号为止（与 omp 的 parseSlashCommand 同一个切法）', () => {
    expect(commandNameOf('/rename 新标题')).toBe('rename')
    expect(commandNameOf('/skill:review 看看')).toBe('skill')
    expect(commandNameOf('  /fast')).toBe('fast')
    expect(commandNameOf('/')).toBeNull()
    expect(commandNameOf('不是命令')).toBeNull()
  })

  test('参数是名字之后那一截，首尾空白去掉', () => {
    expect(commandArgsOf('/rename   新标题  ')).toBe('新标题')
    expect(commandArgsOf('/fast')).toBe('')
    expect(commandArgsOf('不是命令')).toBe('')
  })

  test('按名字或别名在 omp 的表里找', () => {
    const list: SlashCommand[] = [
      {
        name: 'model',
        aliases: ['models'],
        description: null,
        hint: null,
        source: 'builtin',
        subcommands: [],
      },
    ]
    expect(matchCommand(list, '/models')?.name).toBe('model')
    expect(matchCommand(list, '/model opus')?.name).toBe('model')
    expect(matchCommand(list, '/unknown')).toBeNull()
  })
})

describe('命令的挑选与排序', () => {
  const list = [
    command('context', { description: '查看上下文用量明细' }),
    command('compact', { description: '把较早的对话压缩成摘要，腾出上下文' }),
    command('model', { aliases: ['models'], description: '切换模型' }),
    command('handoff', { description: '把对话整理成交接摘要，并就地压缩上下文' }),
  ]
  const names = (query: string) => rankCommands(list, query).map((entry) => entry.name)

  test('空串交回整张表，次序不动', () => {
    expect(names('')).toEqual(['context', 'compact', 'model', 'handoff'])
  })

  test('名字相等排第一，其次前缀，同档按表的次序', () => {
    expect(names('compact')).toEqual(['compact'])
    expect(names('co')).toEqual(['context', 'compact'])
  })

  test('别名前缀与名字包含也算；大小写不论', () => {
    expect(names('MODELS')).toEqual(['model'])
    expect(names('off')).toEqual(['handoff'])
  })

  test('中文说明也能搜到（敲 /压缩 找得到 /compact）', () => {
    expect(names('压缩')).toEqual(['compact', 'handoff'])
  })
})

describe('选项的过滤', () => {
  const choices: CommandChoice[] = [
    { value: 'on', label: '开' },
    { value: 'off', label: '关' },
    { value: 'anthropic/claude-opus', label: 'Claude Opus' },
  ]
  const values = (query: string) => rankChoices(choices, query).map((entry) => entry.value)

  test('空串交回全部；原词或名字都能对上，前缀先于包含', () => {
    expect(values('')).toEqual(['on', 'off', 'anthropic/claude-opus'])
    expect(values('关')).toEqual(['off'])
    expect(values('opus')).toEqual(['anthropic/claude-opus'])
    expect(values('o')).toEqual(['on', 'off', 'anthropic/claude-opus'])
  })

  test('一项都对不上交回空表', () => {
    expect(values('gemini')).toEqual([])
  })
})
