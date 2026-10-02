import { describe, expect, test } from 'bun:test'
import { createCommandRegistry, type RegisteredCommand } from './command-registry'

/*
 * registerAll 的存在理由只有一个：一次列表变化只许通知一次。
 * 逐条 register 会让每个订阅者被叫 2N 次，而订阅者里两个都要重建整张键位表。
 */

function command(id: string): RegisteredCommand {
  return { id, label: id, execute: () => undefined }
}

describe('command registry batching', () => {
  test('a batch reaches subscribers exactly once', () => {
    const registry = createCommandRegistry()
    let notifications = 0
    registry.subscribe(() => {
      notifications += 1
    })

    const release = registry.registerAll([command('a'), command('b'), command('c')])
    expect(notifications).toBe(1)
    expect(registry.getSnapshot().map((entry) => entry.id)).toEqual(['a', 'b', 'c'])

    release()
    expect(notifications).toBe(2)
    expect(registry.getSnapshot()).toEqual([])
  })

  test('a duplicate inside the batch leaves nothing behind', () => {
    const registry = createCommandRegistry()
    registry.register(command('taken'))

    expect(() => registry.registerAll([command('fresh'), command('taken')])).toThrow(
      'COMMAND_ALREADY_REGISTERED',
    )
    // 半批不许留下：fresh 不能存活，taken 也不能被顶掉。
    expect(registry.getSnapshot().map((entry) => entry.id)).toEqual(['taken'])
  })

  test('releasing a batch twice does not drop a later registration', () => {
    const registry = createCommandRegistry()
    const release = registry.registerAll([command('a')])
    release()

    registry.register(command('a'))
    release()

    expect(registry.getSnapshot().map((entry) => entry.id)).toEqual(['a'])
  })
})
