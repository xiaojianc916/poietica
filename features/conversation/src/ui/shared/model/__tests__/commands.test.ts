import { describe, expect, test } from 'bun:test'
import type { SlashCommand } from '@poietica/engine'
import { hasCommand } from '../commands'

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
