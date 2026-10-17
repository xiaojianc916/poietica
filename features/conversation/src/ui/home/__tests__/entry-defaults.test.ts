import { describe, expect, test } from 'bun:test'
import { createComposerStore } from '../../composer/composer-store'
import { createEntryDefaults, type EntryDefaultChoice } from '../entry-defaults'

/*
 * 问题 1 二期：入口页的模型 / 档位写穿「新对话默认」意图，草稿只留还没写成功的那一笔。
 */
const A = { provider: 'p', id: 'a' }
const B = { provider: 'p', id: 'b' }

interface Gate {
  readonly promise: Promise<void>
  open(): void
  fail(cause: unknown): void
}

function gate(): Gate {
  let open = (): void => undefined
  let fail = (_cause: unknown): void => undefined
  const promise = new Promise<void>((resolve, reject) => {
    open = resolve
    fail = reject
  })
  return { promise, open, fail }
}

describe('composer.settleSelection', () => {
  test('只抹掉仍等于写出去那个值的键，别的格原样留着', () => {
    const store = createComposerStore()
    store.setSelection(null, { model: A, thinking: 'high', posture: 'ask', plan: true })
    store.settleSelection(null, { model: { ...A }, thinking: 'low' })
    /* model 相等被抹掉；thinking 写的途中被人改成了 high，不等于写出去的 low，留着 */
    expect(store.selectionOf(null)).toEqual({ thinking: 'high', posture: 'ask', plan: true })
    store.settleSelection(null, { thinking: 'high' })
    expect(store.selectionOf(null)).toEqual({ posture: 'ask', plan: true })
  })
})

describe('createEntryDefaults', () => {
  test('写成功后草稿里的模型 / 档位被抹掉；草稿里没有就不写', async () => {
    const composer = createComposerStore()
    const written: EntryDefaultChoice[] = []
    const defaults = createEntryDefaults({
      composer,
      write: async (choice) => {
        written.push(choice)
      },
    })
    await defaults.flush()
    expect(written).toEqual([])

    composer.setSelection(null, { thinking: 'max', posture: 'ask' })
    await defaults.flush()
    /* 只改档位：模型交 null，由 Core 解出显示的那条 */
    expect(written).toEqual([{ model: null, thinking: 'max' }])
    expect(composer.selectionOf(null)).toEqual({ posture: 'ask' })

    composer.setSelection(null, { model: B })
    await defaults.flush()
    /* 只换模型：档位省略 = 保留意图里原来的那一档 */
    expect(written.at(-1)).toEqual({ model: B })
    expect(composer.selectionOf(null)).toEqual({ posture: 'ask' })
  })

  test('写失败：上报、草稿留着，下一次 flush 再写', async () => {
    const composer = createComposerStore()
    const reported: unknown[] = []
    let fail = true
    const defaults = createEntryDefaults({
      composer,
      write: async () => {
        if (fail) throw new Error('core restarting')
      },
      report: (cause) => reported.push(cause),
    })
    composer.setSelection(null, { model: A, thinking: 'low' })
    await defaults.flush()
    expect(reported).toHaveLength(1)
    expect(composer.selectionOf(null)).toEqual({ model: A, thinking: 'low' })

    fail = false
    await defaults.flush()
    expect(composer.selectionOf(null)).toEqual({})
  })

  test('串行：写的途中又改了一格，等这一次写完按最新草稿再写一次，不丢那一下', async () => {
    const composer = createComposerStore()
    const gates: Gate[] = []
    const written: EntryDefaultChoice[] = []
    const defaults = createEntryDefaults({
      composer,
      write: (choice) => {
        written.push(choice)
        const next = gate()
        gates.push(next)
        return next.promise
      },
    })
    composer.setSelection(null, { model: A })
    const first = defaults.flush()
    composer.setSelection(null, { model: B })
    const second = defaults.flush()
    expect(written).toEqual([{ model: A }])

    gates[0]!.open()
    await Promise.resolve()
    await Promise.resolve()
    /* 第一次写的是 A，草稿已是 B：B 不能被当成「已落账」抹掉 */
    expect(composer.selectionOf(null)).toEqual({ model: B })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(written).toEqual([{ model: A }, { model: B }])
    gates[1]!.open()
    await Promise.all([first, second])
    expect(composer.selectionOf(null)).toEqual({})
  })
})
