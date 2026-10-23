import { describe, expect, test } from 'bun:test'
import type { SetupUiStateKey } from '../../contract'
import type { UiStateSlotSpec } from '../../ui-api'
import { openUiStateSlot } from '../ui-state-slot'

/*
 * setup 阶段的 uiState 键（契约 UI_STATE_RESTORE）共用的恢复 / 写回规则。以前布局、路由、草稿、批准方式各写一遍，
 * 踩过的坑都在这里各对一条用例：恢复前把默认值写回盘上（盖掉存下的那份）、恢复本身写回、读失败时拿空状态覆盖盘上真值、
 * 去抖时在变更那一刻判闸门（hydrate 之后那次写被吞掉）。
 */

interface Disk {
  readonly reads: number
  readonly writes: unknown[]
  /** 让在途的那一次读落地：给值 = 成功，给 Error = 失败 */
  answer(value: unknown): Promise<void>
}

function slotHarness<T>(overrides: Partial<UiStateSlotSpec<T>> & Pick<UiStateSlotSpec<T>, 'readFailure'>) {
  let state: unknown = 'default'
  const listeners = new Set<() => void>()
  const set = (value: unknown): void => {
    state = value
    for (const l of [...listeners]) l()
  }
  let reads = 0
  const writes: unknown[] = []
  let pending: { resolve: (v: unknown) => void; reject: (e: unknown) => void } | null = null
  const settled: string[] = []
  const reported: string[] = []
  const slot = openUiStateSlot(
    {
      get: () => {
        reads += 1
        return new Promise((resolve, reject) => {
          pending = { resolve, reject }
        })
      },
      set: async (_key: SetupUiStateKey, value: unknown) => {
        writes.push(value)
      },
    },
    {
      key: 'layout',
      parse: (stored) => (stored === null ? null : (stored as T)),
      restore: (value) => set(value),
      snapshot: () => state,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
      onSettled: (outcome) => {
        settled.push(outcome)
      },
      report: (_cause, op) => {
        reported.push(op)
      },
      ...overrides,
    },
  )
  const disk: Disk = {
    get reads() {
      return reads
    },
    writes,
    async answer(value) {
      const p = pending
      pending = null
      if (value instanceof Error) p?.reject(value)
      else p?.resolve(value)
      for (let i = 0; i < 5; i += 1) await Promise.resolve()
    },
  }
  return { slot, disk, set, state: () => state, settled, reported }
}

describe('uiState 槽：setup 阶段的恢复与写回', () => {
  test('创建时就读；恢复本身不写回', async () => {
    const h = slotHarness({ readFailure: 'release' })
    expect(h.disk.reads).toBe(1)
    expect(h.slot.restored()).toBe(false)

    await h.disk.answer('saved')

    expect(h.state()).toBe('saved')
    expect(h.slot.restored()).toBe(true)
    expect(h.settled).toEqual(['restored'])
    expect(h.disk.writes).toEqual([])
  })

  test('恢复之后的变更同步写回整份快照', async () => {
    const h = slotHarness({ readFailure: 'release' })
    await h.disk.answer('saved')

    h.set('changed')

    expect(h.disk.writes).toEqual(['changed'])
  })

  test('恢复之前的变更不写（会盖掉盘上那份），恢复完成后补写一次当前状态', async () => {
    const h = slotHarness({ readFailure: 'release', restore: () => undefined })
    h.set('early')
    h.set('earlier')
    expect(h.disk.writes).toEqual([])

    await h.disk.answer('saved')

    expect(h.disk.writes).toEqual(['earlier'])
  })

  test('parse 拒绝的值（或盘上没有）：不调 restore，照常放行写回', async () => {
    const h = slotHarness({ readFailure: 'hold' })
    await h.disk.answer(null)

    expect(h.state()).toBe('default')
    expect(h.slot.restored()).toBe(true)
    h.set('changed')
    expect(h.disk.writes).toEqual(['changed'])
  })

  test('读失败 + release：当作盘上没有，照常写回', async () => {
    const h = slotHarness({ readFailure: 'release' })
    await h.disk.answer(new Error('disk busy'))

    expect(h.slot.restored()).toBe(true)
    expect(h.settled).toEqual(['failed'])
    expect(h.reported).toEqual(['read'])
    h.set('changed')
    expect(h.disk.writes).toEqual(['changed'])
  })

  test('读失败 + hold：一直不写回；retry 读成功后才放行，并补写恢复前后的变更', async () => {
    const h = slotHarness<Record<string, string>>({
      readFailure: 'hold',
      restore: (saved) => h.set({ ...(h.state() as object), ...saved }),
    })
    h.set({ typed: 'a' })
    await h.disk.answer(new Error('disk busy'))
    h.set({ typed: 'ab' })

    expect(h.slot.restored()).toBe(false)
    expect(h.settled).toEqual(['failed'])
    expect(h.disk.writes).toEqual([])

    const retried = h.slot.retry()
    expect(h.disk.reads).toBe(2)
    await h.disk.answer({ saved: 'x' })
    await retried

    expect(h.slot.restored()).toBe(true)
    expect(h.settled).toEqual(['failed', 'restored'])
    expect(h.disk.writes).toEqual([{ typed: 'ab', saved: 'x' }])
  })

  test('retry：在途时不重复读，已恢复后不再读', async () => {
    const h = slotHarness({ readFailure: 'hold' })
    void h.slot.retry()
    void h.slot.retry()
    expect(h.disk.reads).toBe(1)

    await h.disk.answer('saved')
    await h.slot.retry()

    expect(h.disk.reads).toBe(1)
  })

  test('去抖：闸门在真正发写的那一刻判 —— 恢复前排下的写到点时已恢复就写出，一串变更并成一次', async () => {
    const h = slotHarness({ readFailure: 'hold', debounceMs: 5, restore: () => undefined })
    h.set('a')
    await h.disk.answer('saved')
    expect(h.disk.writes).toEqual([])
    await Bun.sleep(20)
    expect(h.disk.writes).toEqual(['a'])

    h.set('ab')
    h.set('abc')
    await Bun.sleep(20)

    expect(h.disk.writes).toEqual(['a', 'abc'])
  })

  test('dispose 之后：不再读回、不再写', async () => {
    const h = slotHarness({ readFailure: 'release', debounceMs: 5 })
    h.slot.dispose()
    await h.disk.answer('saved')
    h.set('changed')
    await Bun.sleep(20)

    expect(h.state()).toBe('changed')
    expect(h.disk.writes).toEqual([])
    expect(h.settled).toEqual([])
  })

  test('写失败只上报、不抛', async () => {
    const reported: string[] = []
    let state = 'default'
    let notify: () => void = () => undefined
    const slot = openUiStateSlot(
      {
        get: async () => null,
        set: async () => {
          throw new Error('disk full')
        },
      },
      {
        key: 'navigation',
        parse: () => null,
        restore: () => undefined,
        snapshot: () => state,
        subscribe: (listener) => {
          notify = listener
          return () => undefined
        },
        readFailure: 'release',
        report: (_cause, op) => {
          reported.push(op)
        },
      },
    )
    await slot.retry()
    await Promise.resolve()
    state = 'changed'
    notify()
    await Bun.sleep(0)

    expect(reported).toEqual(['write'])
  })
})
