import { describe, expect, test } from 'bun:test'
import type { DraftAttachments } from '@poietica/feature-conversation/ui-api'
import { createDraftRefSync, DRAFTS_OWNER } from '../draft-refs'

/**
 * R-07 U1–U6：草稿引用同步（attachments 侧）。
 *
 * 用一个手推的假草稿视图 + 记录调用的假 setOwnerRefs：要钉的是**时序与幂等**，
 * 不是 RPC 本身（那条路在 module.test.ts 里走真内核）。
 */
interface Calls {
  readonly refs: { ownerKey: string; ids: readonly string[] }[]
  readonly dropped: string[][]
  readonly reported: number[]
  readonly warns: string[]
}

function make(opts: { restored?: boolean; missing?: (ids: readonly string[]) => string[]; failFirst?: boolean } = {}) {
  const calls: Calls = { refs: [], dropped: [], reported: [], warns: [] }
  const listeners = new Set<() => void>()
  let ids: readonly string[] | null = opts.restored === false ? null : []
  let failNext = opts.failFirst === true

  const applyDrop = (toDrop: readonly string[]): number => {
    if (ids === null) return 0
    const kept = ids.filter((id) => !toDrop.includes(id))
    const removed = ids.length - kept.length
    if (removed > 0) {
      ids = kept
      for (const l of [...listeners]) l()
    }
    return removed
  }

  let inFlight = 0
  let maxInFlight = 0
  const arrivalOrder: string[] = []
  const drafts: DraftAttachments = {
    ids: () => ids,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    drop: (toDrop) => {
      calls.dropped.push([...toDrop])
      return applyDrop(toDrop)
    },
  }
  const sync = createDraftRefSync({
    drafts,
    debounceMs: 1,
    setOwnerRefs: async (ownerKey, attachmentIds) => {
      if (failNext) {
        failNext = false
        throw new Error('core 在重启')
      }
      calls.refs.push({ ownerKey, ids: [...attachmentIds] })
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      // 让请求有真正的交错窗口，U6 才验得到串行
      await new Promise((r) => setTimeout(r, 2))
      inFlight -= 1
      arrivalOrder.push(attachmentIds.join(','))
      const missing = opts.missing?.(attachmentIds) ?? []
      return { missing }
    },
    warn: (message, data) => {
      calls.warns.push(`${message}:${String(data.error)}`)
    },
    reportMissing: (count) => {
      calls.reported.push(count)
    },
  })
  return {
    sync,
    calls,
    ids: () => ids,
    setIds: (next: readonly string[]) => {
      ids = next
      for (const l of [...listeners]) l()
    },
    restore: (next: readonly string[]) => {
      ids = next
      for (const l of [...listeners]) l()
    },
    maxInFlight: () => maxInFlight,
    arrivalOrder: () => arrivalOrder,
  }
}

describe('草稿引用同步（R-07 §3.4 方案 1）', () => {
  test('U1 草稿还没恢复（ids 为 null）时不发请求', async () => {
    const t = make({ restored: false })
    t.sync.schedule()
    await t.sync.flush()
    expect(t.calls.refs).toEqual([])
    t.sync.dispose()
  })

  test('U2 连续两次变化只发一次，参数是最新的集合', async () => {
    const t = make()
    t.setIds(['b', 'a'])
    t.setIds(['a', 'b'])
    t.sync.schedule()
    t.sync.schedule()
    await t.sync.flush()
    expect(t.calls.refs).toEqual([{ ownerKey: DRAFTS_OWNER, ids: ['a', 'b'] }])
    t.sync.dispose()
  })

  test('U3 集合不变不重发；onCoreReady 后无条件重发一次', async () => {
    const t = make()
    t.setIds(['a'])
    await t.sync.flush()
    expect(t.calls.refs).toHaveLength(1)

    t.sync.onCoreReady()
    await t.sync.flush()
    expect(t.calls.refs).toHaveLength(2)

    /* 再 ready 一次：仍然是重发（上一代 Core 收到的那份不算数） */
    t.sync.onCoreReady()
    await t.sync.flush()
    expect(t.calls.refs).toHaveLength(3)
    t.sync.dispose()
  })

  test('U4 返回 missing：调 drop 清掉并提示实际移除的条数', async () => {
    const t = make({ missing: () => ['gone'] })
    t.setIds(['a', 'gone'])
    await t.sync.flush()
    expect(t.calls.dropped).toEqual([['gone']])
    expect(t.ids()).toEqual(['a'])
    expect(t.calls.reported).toEqual([1])
    t.sync.dispose()
  })

  test('U5 请求失败：记 warn、不记住集合，下一次变化时重发', async () => {
    const t = make({ failFirst: true })
    t.setIds(['a'])
    t.sync.schedule()
    await t.sync.flush()
    expect(t.calls.warns).toHaveLength(1)
    expect(t.calls.warns[0]).toContain('draft attachment pin failed')

    /* 失败没有被记住：下一次同步重发同一个集合 */
    t.sync.schedule()
    await t.sync.flush()
    expect(t.calls.refs).toEqual([{ ownerKey: DRAFTS_OWNER, ids: ['a'] }])
    t.sync.dispose()
  })

  test('U6 连续两次变化：请求串行，按发起顺序到达', async () => {
    const t = make()
    t.setIds(['a'])
    const first = t.sync.flush()
    /* 让第一条请求进入在途状态（假 setOwnerRefs 睡 2ms），再改集合发第二条 */
    await new Promise((r) => setTimeout(r, 0))
    expect(t.calls.refs).toEqual([{ ownerKey: DRAFTS_OWNER, ids: ['a'] }])
    t.setIds(['b'])
    const second = t.sync.flush()
    await Promise.all([first, second])
    expect(t.maxInFlight()).toBe(1)
    expect(t.arrivalOrder()).toEqual(['a', 'b'])
    t.sync.dispose()
  })

  /*
   * 守则 8.1：`schedule()` 用 `void flush()` 起那一段，链子上不许有没人接的 rejection。
   * 视图读草稿自己抛错（比如 store 已经被拆）时也要走 warn，不能变成未处理异常。
   */
  test('U6b 读草稿本身抛错：记 warn，不留下未处理的 rejection', async () => {
    const warns: string[] = []
    const sync = createDraftRefSync({
      drafts: {
        ids: () => {
          throw new Error('store 已经拆了')
        },
        subscribe: () => () => undefined,
        drop: () => 0,
      },
      debounceMs: 1,
      setOwnerRefs: () => Promise.resolve({ missing: [] }),
      warn: (message, data) => {
        warns.push(`${message}:${String(data.error)}`)
      },
      reportMissing: () => undefined,
    })

    sync.schedule()
    await sync.flush()
    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain('store 已经拆了')
    sync.dispose()
  })
})
