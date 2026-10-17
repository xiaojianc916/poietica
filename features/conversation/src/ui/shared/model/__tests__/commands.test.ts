import { describe, expect, test } from 'bun:test'
import type { SlashCommand } from '@poietica/engine'
import { hasCommand, rankCommands, requiresArgument, slashQueryOf } from '../commands'

const retry: SlashCommand = {
  name: 'retry',
  aliases: [],
  description: null,
  hint: null,
  source: 'builtin',
  subcommands: [],
}

/* O-02：命令表是异步读来的，表面先画时它可能还没有值；快捷按钮的判据不能因此炸掉。 */
describe('命令表尚未读到', () => {
  test('没有表时按「没有这条命令」处理', () => {
    expect(hasCommand(undefined, 'retry')).toBe(false)
  })

  test('表到了才认它', () => {
    expect(hasCommand([retry], 'retry')).toBe(true)
    expect(hasCommand([retry], 'compact')).toBe(false)
  })
})

const command = (name: string, extra: Partial<SlashCommand> = {}): SlashCommand => ({
  name,
  aliases: [],
  description: null,
  hint: null,
  source: 'builtin',
  subcommands: [],
  ...extra,
})

/* U-1：斜杠面板只在「行首 `/` 加名字」时出来；已经在写参数、或斜杠在句中，都不是在挑命令。 */
describe('草稿是不是在敲命令名', () => {
  test('刚敲下斜杠、敲了半截名字：是', () => {
    expect(slashQueryOf('/')).toBe('')
    expect(slashQueryOf('/comp')).toBe('comp')
  })

  test('写参数、换行、句中斜杠、行首空白：不是', () => {
    expect(slashQueryOf('/compact 只保留结论')).toBeNull()
    expect(slashQueryOf('/compact\n')).toBeNull()
    expect(slashQueryOf('看一下 /usr/bin')).toBeNull()
    expect(slashQueryOf(' /compact')).toBeNull()
  })
})

describe('命令的挑选与排序', () => {
  const list = [
    command('context', { description: '查看上下文用量明细' }),
    command('compact', { description: '把较早的对话压缩成摘要，腾出上下文' }),
    command('model', { aliases: ['models'], description: '查看当前的模型设置' }),
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

describe('选中命令时要不要先补参数', () => {
  test('必填参数（<…>）先补参数；可选参数与不带参数的直接执行', () => {
    expect(requiresArgument(command('add-dir', { hint: '<路径>' }))).toBe(true)
    expect(requiresArgument(command('compact', { hint: '[关注点]' }))).toBe(false)
    expect(requiresArgument(command('retry'))).toBe(false)
  })
})
