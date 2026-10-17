import { describe, expect, test } from 'bun:test'
import { agentRefsOf, isSubagentChannelId } from '../agent-refs'

describe('isSubagentChannelId', () => {
  test('omp 的子代理号（含嵌套的点号）都认；main 与路径样的号不认', () => {
    expect(isSubagentChannelId('SwiftFalcon')).toBe(true)
    expect(isSubagentChannelId('Anna-2')).toBe(true)
    expect(isSubagentChannelId('Parent.Child')).toBe(true)
    expect(isSubagentChannelId('main')).toBe(false)
    expect(isSubagentChannelId('..')).toBe(false)
    expect(isSubagentChannelId('a/b')).toBe(false)
    expect(isSubagentChannelId('')).toBe(false)
  })
})

describe('agentRefsOf', () => {
  test('task 工具：progress 与 results 去重保序', () => {
    const output = {
      content: [],
      details: { progress: [{ id: 'Anna' }, { id: 'Bob' }], results: [{ id: 'Bob' }, { id: 'Cleo' }] },
    }
    expect(agentRefsOf('task', output)).toEqual([
      { agentId: 'Anna', role: 'child' },
      { agentId: 'Bob', role: 'child' },
      { agentId: 'Cleo', role: 'child' },
    ])
  })

  test('别的工具、没有 details、没有子代理：不写这一格', () => {
    expect(agentRefsOf('bash', { details: { progress: [{ id: 'Anna' }] } })).toBeUndefined()
    expect(agentRefsOf('task', { content: [] })).toBeUndefined()
    expect(agentRefsOf('task', { details: { progress: [] } })).toBeUndefined()
    expect(agentRefsOf('task', { details: { progress: [{ id: 'main' }, { id: 7 }] } })).toBeUndefined()
  })
})
