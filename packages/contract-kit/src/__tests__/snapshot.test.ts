import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { composeContracts, contractSnapshot } from '../compose'
import { defineContract, defineErrors, defineMethod, defineNotification } from '../define'

const first = defineContract({
  id: 'alpha',
  namespaces: ['alpha'],
  methods: [
    defineMethod({
      name: 'alpha.one',
      owner: 'core',
      params: z.object({ a: z.string() }),
      result: z.object({ ok: z.boolean() }),
      description: '第一个',
    }),
  ],
  notifications: [
    defineNotification({ name: 'alpha.changed', owner: 'core', params: z.object({}), description: '变了' }),
  ],
  errors: defineErrors('alpha', { missing: '没有' }),
})

const second = defineContract({
  id: 'beta',
  namespaces: ['beta'],
  methods: [
    defineMethod({
      name: 'beta.two',
      owner: 'host',
      params: z.object({}),
      result: z.object({}),
      description: '第二个',
    }),
  ],
  notifications: [],
  errors: defineErrors('beta', {}),
})

describe('contractSnapshot', () => {
  test('契约顺序不同 → 输出完全相同', () => {
    expect(contractSnapshot(composeContracts(first, second))).toBe(contractSnapshot(composeContracts(second, first)))
  })

  test('输出以换行结尾且能被 JSON.parse', () => {
    const text = contractSnapshot(composeContracts(first))
    expect(text.endsWith('\n')).toBe(true)
    const parsed = JSON.parse(text) as { methods: unknown[]; notifications: unknown[]; errors: unknown[] }
    expect(Array.isArray(parsed.methods)).toBe(true)
    expect(parsed.methods.length).toBe(4) // 3 个系统方法 + alpha.one
  })

  test('含 z.custom() 的 schema 不抛错', () => {
    const custom = defineContract({
      id: 'gamma',
      namespaces: ['gamma'],
      methods: [
        defineMethod({
          name: 'gamma.x',
          owner: 'core',
          params: z.object({ weird: z.custom<() => void>() }),
          result: z.object({}),
          description: '自定义',
        }),
      ],
      notifications: [],
      errors: defineErrors('gamma', {}),
    })
    expect(() => contractSnapshot(composeContracts(custom))).not.toThrow()
  })
})
