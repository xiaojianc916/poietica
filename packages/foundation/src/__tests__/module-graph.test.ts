import { describe, expect, test } from 'bun:test'
import type { AppError } from '../errors'
import { sortModules } from '../module-graph'

const node = (id: string, dependsOn?: string[]): { id: string; dependsOn?: string[] } =>
  dependsOn === undefined ? { id } : { id, dependsOn }

function thrown(run: () => unknown): AppError {
  try {
    run()
  } catch (error) {
    return error as AppError
  }
  throw new Error('本该抛错')
}

describe('sortModules', () => {
  test('无依赖保持原顺序；依赖在后的被提前', () => {
    expect(sortModules([node('c'), node('a'), node('b')]).map((m) => m.id)).toEqual(['c', 'a', 'b'])
    expect(sortModules([node('usage', ['conversation']), node('conversation')]).map((m) => m.id)).toEqual([
      'conversation',
      'usage',
    ])
  })

  test('重复 id → module_graph_invalid；缺失依赖、自依赖、非法 id 各自报出原因', () => {
    expect(thrown(() => sortModules([node('a'), node('a')])).code).toBe('kernel.module_graph_invalid')
    expect(() => sortModules([node('a', ['ghost'])])).toThrow('不在模块清单中')
    expect(() => sortModules([node('a', ['a'])])).toThrow('依赖了自己')
    expect(() => sortModules([node('Conversation')])).toThrow('模块 id 不合法')
    expect(() => sortModules([node('agent_settings')])).toThrow('模块 id 不合法')
  })

  test('三元环的 message 含 a → b → c → a', () => {
    expect(thrown(() => sortModules([node('a', ['b']), node('b', ['c']), node('c', ['a'])])).message).toContain(
      'a → b → c → a',
    )
  })
})
