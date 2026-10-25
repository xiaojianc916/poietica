import { afterEach, describe, expect, test } from 'bun:test'
import type { TurnChangesApi, TurnChangesView } from '@poietica/feature-conversation/ui-api'
import { useTurnChanges } from '@poietica/feature-conversation/ui-api'
import { createTestLogger } from '@poietica/test-kit'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { type ReactNode, useEffect } from 'react'
import {
  createTurnChangesHolder,
  describeRewind,
  type TurnChangesGateway,
  TurnChangesSource,
  type TurnRewindPreview,
} from '../turn-changes-source'

/*
 * 那条改动条的**数据侧**：按对话读账、读不到保留旧值、变了重读、撤销先 preview 再 apply。
 *
 * 这里钉接线与闸门，不是 review core 的账本规则（那些在 core 的测试里）。最要紧的两条：
 *   - 不能退的那一轮**不许** apply（整轮拒绝，不做部分写回）；
 *   - 人在确认框上点「取消」时，工作区一个字都不动。
 *
 * 状态推导走 act：确认框由 preview 的结论开出来，那些 setState 不包进 act 会刷一屏
 * 「not wrapped in act」，把真正的失败埋掉。
 */

afterEach(cleanup)

const ROWS: readonly TurnChangesView[] = [
  {
    turn: 1,
    fileCount: 1,
    added: 3,
    removed: 1,
    reverted: false,
    files: [{ path: 'a.ts', added: 3, removed: 1 }],
  },
]

const SAFE: TurnRewindPreview = { safe: [{ path: 'a.ts' }], unsafe: [], canApply: true }

const BLOCKED: TurnRewindPreview = {
  safe: [{ path: 'a.ts' }],
  unsafe: [{ path: 'b.ts', reason: 'externally_modified' }],
  canApply: false,
}

interface Calls {
  readonly list: string[]
  readonly preview: Array<{ threadId: string; turn: number }>
  readonly apply: Array<{ threadId: string; turn: number }>
}

type FakeGateway = TurnChangesGateway & {
  readonly calls: Calls
  changed(threadId: string): void
}

function fakeGateway(
  rows: readonly TurnChangesView[],
  preview: () => Promise<TurnRewindPreview> = () => Promise.resolve(SAFE),
): FakeGateway {
  const calls: Calls = { apply: [], list: [], preview: [] }
  const listeners = new Set<(threadId: string) => void>()

  return {
    calls,
    list: (threadId) => {
      calls.list.push(threadId)
      return Promise.resolve(rows)
    },
    preview: (threadId, turn) => {
      calls.preview.push({ threadId, turn })
      return preview()
    },
    apply: (threadId, turn) => {
      calls.apply.push({ threadId, turn })
      return Promise.resolve()
    },
    onChanged: (listener) => {
      listeners.add(listener)
      return {
        dispose: () => {
          listeners.delete(listener)
        },
      }
    },
    changed: (threadId) => {
      for (const listener of [...listeners]) {
        listener(threadId)
      }
    },
  }
}

interface Mounted {
  readonly holder: ReturnType<typeof createTurnChangesHolder>
  readonly api: () => TurnChangesApi
  readonly failures: unknown[]
  readonly unmount: () => void
}

function mount(gateway: FakeGateway): Mounted {
  const holder = createTurnChangesHolder({ gateway, logger: createTestLogger() })
  /* 通知由装配处挂（见 index.tsx）；这里照样挂上，才测得到「账变了 → 重读」。 */
  const off = holder.start()
  const failures: unknown[] = []
  let held: TurnChangesApi | null = null

  function Probe(): ReactNode {
    const api = useTurnChanges()
    useEffect(() => {
      held = api
    }, [api])
    return null
  }

  const rendered = render(
    <TurnChangesSource gateway={gateway} holder={holder} onFailure={(cause) => failures.push(cause)}>
      <Probe />
      <p>转录</p>
    </TurnChangesSource>,
  )

  return {
    api: () => {
      if (held === null) {
        throw new Error('Provider 还没把 api 投到树上')
      }
      return held
    },
    failures,
    holder,
    unmount: () => {
      off()
      rendered.unmount()
    },
  }
}

/** 让这一条对话真的被看着（订阅 = 第一次读取），再等它落地。 */
async function watch(target: Mounted, threadId: string): Promise<() => void> {
  const off = target.holder.subscribe(threadId, () => undefined)
  await waitFor(() => {
    expect(target.holder.changesOf(threadId)).toHaveLength(1)
  })
  return off
}

const button = (label: string): HTMLButtonElement | null =>
  [...document.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === label) ?? null

/** 放掉已排队的微任务与由此带出的渲染：preview 的结论正是靠它开框。 */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

/**
 * 起一次撤销。
 *
 * **不能**写成 `async function (): Promise<Promise<void>>`：async 会把交回的 promise 摊平，
 * 于是 `await startRewind(...)` 会一直等到人回答完 —— 而这一次调用正是要等人回答的那一侧。
 * 所以两件事分开交回：`previewed`（框已经开出来了）与 `running`（整件事办完了）。
 */
function startRewind(
  target: Mounted,
  threadId: string,
  turn: number,
): {
  readonly running: Promise<void>
  readonly previewed: Promise<void>
} {
  const running = target.api().rewind(threadId, turn)
  return { previewed: flush(), running }
}

/** 关框：apply 的交回值会再推一次 state，收尾同样要落在 act 里。 */
async function finish(running: Promise<void>): Promise<void> {
  await act(async () => {
    await running
  })
}
describe('改动条的账本', () => {
  test('第一次有人订阅才去读：渲染期不发请求', async () => {
    const gateway = fakeGateway(ROWS)
    const target = mount(gateway)

    expect(gateway.calls.list).toEqual([])
    expect(target.holder.changesOf('t1')).toEqual([])

    const off = target.holder.subscribe('t1', () => undefined)
    await waitFor(() => {
      expect(target.holder.changesOf('t1').map((row) => row.turn)).toEqual([1])
    })

    off()
    target.unmount()
  })

  test('数据没变时交回同一个引用（getSnapshot 的判据）', async () => {
    const target = mount(fakeGateway(ROWS))
    const off = await watch(target, 't1')
    const first = target.holder.changesOf('t1')

    expect(target.holder.changesOf('t1')).toBe(first)
    off()
    target.unmount()
  })

  test('通知说某条对话的账变了：只重读那一条', async () => {
    const gateway = fakeGateway(ROWS)
    const target = mount(gateway)
    const off = await watch(target, 't1')
    const offOther = target.holder.subscribe('t2', () => undefined)
    await waitFor(() => {
      expect(gateway.calls.list).toEqual(['t1', 't2'])
    })

    await act(async () => {
      gateway.changed('t1')
    })
    await waitFor(() => {
      expect(gateway.calls.list).toEqual(['t1', 't2', 't1'])
    })

    off()
    offOther()
    target.unmount()
  })

  test('Core 换了一世：缓存整体作废，并按看客重读', async () => {
    const gateway = fakeGateway(ROWS)
    const target = mount(gateway)
    const off = await watch(target, 't1')

    await act(async () => {
      target.holder.reset()
    })
    await waitFor(() => {
      expect(gateway.calls.list).toEqual(['t1', 't1'])
      expect(target.holder.changesOf('t1')).toHaveLength(1)
    })

    off()
    target.unmount()
  })

  test('读失败保留旧值，只记一条 warn', async () => {
    const logger = createTestLogger()
    let fail = false
    const gateway: TurnChangesGateway = {
      list: () => (fail ? Promise.reject(new Error('core 没了')) : Promise.resolve(ROWS)),
      preview: () => Promise.resolve(SAFE),
      apply: () => Promise.resolve(),
      onChanged: () => ({ dispose: () => undefined }),
    }
    const holder = createTurnChangesHolder({ gateway, logger })
    const off = holder.subscribe('t1', () => undefined)
    await waitFor(() => {
      expect(holder.changesOf('t1')).toHaveLength(1)
    })

    fail = true
    holder.reload('t1')
    await waitFor(() => {
      expect(logger.records.some((record) => record.msg === 'turn changes unreadable')).toBe(true)
    })

    /* 屏幕上那一条不该因为一次读失败就凭空消失。 */
    expect(holder.changesOf('t1')).toHaveLength(1)
    off()
  })

  test('没有看客时 reload 是空操作：不留一条没人看的读取', async () => {
    const gateway = fakeGateway(ROWS)
    const target = mount(gateway)
    const off = await watch(target, 't1')

    off()
    target.holder.reload('t1')

    expect(gateway.calls.list).toEqual(['t1'])
    target.unmount()
  })
})

describe('撤销这一问', () => {
  test('确认之后才 apply，并重读这一条对话', async () => {
    const gateway = fakeGateway(ROWS)
    const target = mount(gateway)
    const off = await watch(target, 't1')

    const { previewed, running } = startRewind(target, 't1', 1)
    await previewed
    expect(gateway.calls.preview).toEqual([{ threadId: 't1', turn: 1 }])
    expect(gateway.calls.apply).toEqual([])

    await act(async () => {
      fireEvent.click(button('撤销') as HTMLButtonElement)
    })
    await finish(running)

    expect(gateway.calls.apply).toEqual([{ threadId: 't1', turn: 1 }])
    expect(gateway.calls.list).toEqual(['t1', 't1'])
    off()
    target.unmount()
  })

  test('取消：preview 过了，apply 一次都没调', async () => {
    const gateway = fakeGateway(ROWS)
    const target = mount(gateway)
    const off = await watch(target, 't1')

    const { previewed, running } = startRewind(target, 't1', 1)
    await previewed
    expect(gateway.calls.preview).toHaveLength(1)

    await act(async () => {
      fireEvent.click(button('取消') as HTMLButtonElement)
    })
    await finish(running)

    expect(gateway.calls.apply).toEqual([])
    off()
    target.unmount()
  })

  test('有文件被改过：确认键禁用，一个字都不写回', async () => {
    const gateway = fakeGateway(ROWS, () => Promise.resolve(BLOCKED))
    const target = mount(gateway)
    const off = await watch(target, 't1')

    const { previewed, running } = startRewind(target, 't1', 1)
    await previewed
    expect(document.body.textContent).toContain('不能撤销')
    expect(button('撤销')?.disabled).toBe(true)

    await act(async () => {
      fireEvent.click(button('取消') as HTMLButtonElement)
    })
    await finish(running)

    expect(gateway.calls.apply).toEqual([])
    off()
    target.unmount()
  })

  test('preview 自己失败：报到 onFailure，不弹框', async () => {
    const gateway = fakeGateway(ROWS, () => Promise.reject(new Error('rewind_not_available')))
    const target = mount(gateway)
    const off = await watch(target, 't1')

    const { previewed, running } = startRewind(target, 't1', 9)
    await previewed
    await finish(running)

    expect(target.failures).toHaveLength(1)
    expect(document.body.textContent).not.toContain('撤销本轮文件改动')
    off()
    target.unmount()
  })

  test('已经有一问挂着时，第二下不再开框（回执只有一个位置）', async () => {
    const gateway = fakeGateway(ROWS)
    const target = mount(gateway)
    const off = await watch(target, 't1')

    const first = startRewind(target, 't1', 1)
    await first.previewed
    expect(gateway.calls.preview).toHaveLength(1)

    /* 第二下直接返回：它不能把先前那一问的回执覆盖掉。 */
    const second = startRewind(target, 't1', 2)
    await second.previewed
    await finish(second.running)
    expect(gateway.calls.preview).toHaveLength(1)

    await act(async () => {
      fireEvent.click(button('取消') as HTMLButtonElement)
    })
    await finish(first.running)

    expect(gateway.calls.apply).toEqual([])
    off()
    target.unmount()
  })
})

describe('确认框的文案', () => {
  test('能退：报文件数，并说明对话不回退', () => {
    const text = describeRewind({ safe: [{ path: 'a' }, { path: 'b' }], unsafe: [], canApply: true })

    expect(text).toContain('2 个文件')
    expect(text).toContain('对话内容不会回退')
  })

  test('不能退：两类原因分开数', () => {
    const text = describeRewind({
      safe: [],
      unsafe: [
        { path: 'a', reason: 'externally_modified' },
        { path: 'b', reason: 'externally_modified' },
        { path: 'c', reason: 'missing' },
      ],
      canApply: false,
    })

    expect(text).toContain('2 个被改过')
    expect(text).toContain('1 个已不存在')
    expect(text).toContain('不能撤销')
  })
})
