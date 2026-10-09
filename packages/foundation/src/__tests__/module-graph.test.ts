import { describe, expect, test } from 'bun:test'
import { AppError } from '../errors'
import { sortModules } from '../module-graph'

const node = (id: string, dependsOn?: string[]): { id: string; dependsOn?: string[] } =>
  dependsOn === undefined ? { id } : { id, dependsOn }

describe('sortModules', () => {
  test('无依赖时保持原顺序', () => {
    const modules = [node('c'), node('a'), node('b')]
    expect(sortModules(modules).map((m) => m.id)).toEqual(['c', 'a', 'b'])
  })

  test('依赖在后的模块被提前', () => {
    const modules = [node('usage', ['conversation']), node('conversation')]
    expect(sortModules(modules).map((m) => m.id)).toEqual(['conversation', 'usage'])
  })

  test('重复 id 抛 module_graph_invalid', () => {
    const error = (() => {
      try {
        sortModules([node('a'), node('a')])
      } catch (e) {
        return e
      }
      return undefined
    })()
    expect(error).toBeInstanceOf(AppError)
    expect((error as AppError).code).toBe('kernel.module_graph_invalid')
  })

  test('缺失依赖抛错', () => {
    expect(() => sortModules([node('a', ['ghost'])])).toThrow('不在模块清单中')
  })

  test('自依赖抛错', () => {
    expect(() => sortModules([node('a', ['a'])])).toThrow('依赖了自己')
  })

  test('三元环的 message 含 a → b → c → a', () => {
    const error = (() => {
      try {
        sortModules([node('a', ['b']), node('b', ['c']), node('c', ['a'])])
      } catch (e) {
        return e
      }
      return undefined
    })()
    expect((error as AppError).message).toContain('a → b → c → a')
  })

  test('非法 id 抛错', () => {
    expect(() => sortModules([node('Conversation')])).toThrow('模块 id 不合法')
    expect(() => sortModules([node('agent_settings')])).toThrow('模块 id 不合法')
  })
})
