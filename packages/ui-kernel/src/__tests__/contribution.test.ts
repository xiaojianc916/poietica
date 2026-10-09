import { describe, expect, test } from 'bun:test'
import { AppError } from '@poietica/foundation'
import { ContributionRegistry, defineContributionPoint } from '../contribution'

const point = defineContributionPoint<{ id: string; order?: number }>('test.items')

describe('ContributionRegistry', () => {
  test('add / list / dispose', () => {
    const r = new ContributionRegistry()
    const a = r.add(point, 'alpha', { id: 'a' })
    expect(r.list(point).map((c) => c.item.id)).toEqual(['a'])
    a.dispose()
    expect(r.list(point)).toEqual([])
  })

  test('按 order 升序，同 order 按注册先后', () => {
    const r = new ContributionRegistry()
    r.add(point, 'a', { id: 'x', order: 2 })
    r.add(point, 'b', { id: 'y', order: 1 })
    r.add(point, 'c', { id: 'z', order: 1 })
    expect(r.list(point).map((c) => c.item.id)).toEqual(['y', 'z', 'x'])
  })

  test('重复 id 抛错，错误信息里写明是哪两个功能冲突', () => {
    const r = new ContributionRegistry()
    r.add(point, 'alpha', { id: 'same' })
    try {
      r.add(point, 'beta', { id: 'same' })
      throw new Error('应当抛错')
    } catch (e) {
      expect(e).toBeInstanceOf(AppError)
      expect((e as AppError).message).toContain('alpha')
      expect((e as AppError).message).toContain('beta')
      expect((e as AppError).code).toBe('kernel.conflict')
    }
  })

  test('没有 id 的条目不去重', () => {
    const r = new ContributionRegistry()
    r.add(point, 'a', { id: 'a' } as never)
    const p2 = defineContributionPoint<{ order: number }>('test.noId')
    r.add(p2, 'a', { order: 1 })
    r.add(p2, 'a', { order: 1 })
    expect(r.list(p2).length).toBe(2)
  })

  test('list 在没有变化时返回同一引用（useSyncExternalStore 要求）', () => {
    const r = new ContributionRegistry()
    r.add(point, 'a', { id: 'a' })
    expect(r.list(point)).toBe(r.list(point))
    r.add(point, 'a', { id: 'b' })
    const after = r.list(point)
    expect(after).toBe(r.list(point))
  })

  test('subscribe 在变化时通知，dispose 后不再通知', () => {
    const r = new ContributionRegistry()
    let calls = 0
    const off = r.subscribe(point as never, () => {
      calls++
    })
    const d = r.add(point, 'a', { id: 'a' })
    expect(calls).toBe(1)
    d.dispose()
    expect(calls).toBe(2)
    off()
    r.add(point, 'a', { id: 'b' })
    expect(calls).toBe(2)
  })

  test('featureIds 列出贡献过的功能', () => {
    const r = new ContributionRegistry()
    r.add(point, 'alpha', { id: 'a' })
    r.add(point, 'beta', { id: 'b' })
    expect([...r.featureIds()].sort()).toEqual(['alpha', 'beta'])
  })
})
