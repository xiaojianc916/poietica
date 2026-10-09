import { describe, expect, test } from 'bun:test'
import { type UpdateState, UpdateState as UpdateStateSchema } from '../../contract'
import { createUpdateStore } from '../store'

/*
 * 更新界面这一份状态（07 页 §15E）。这里钉的是**三个字段各自的寿数** —— 它们混在一
 * 起才是「菜单里的检查行发起、横幅回话」这条链路的判据：
 *   - `apply` 只换 Host 的投影；
 *   - `dismiss` 是本次运行内的「稍后」；
 *   - `latest` 是手动检查刚回话「已是最新」的一次性标记（`idle` 分不出「没查过」与
 *     「查过没有新版本」，这个标记只能由发起检查的那一侧记）。
 */

const state = (over: Partial<UpdateState> = {}): UpdateState =>
  UpdateStateSchema.parse({
    phase: 'idle',
    currentVersion: '0.5.0',
    version: null,
    notes: null,
    progress: null,
    error: null,
    lastCheckedAt: null,
    ...over,
  })

describe('createUpdateStore', () => {
  test('初值：状态为空、没有稍后、没有「已是最新」标记', () => {
    const s = createUpdateStore()
    expect(s.store.getState()).toEqual({ state: null, dismissed: null, latest: false })
  })

  test('apply 换的是 Host 的投影，不动另外两格', () => {
    const s = createUpdateStore()
    s.dismiss('1.2.3')
    s.announceLatest()
    s.apply(state({ phase: 'available', version: '1.2.4' }))
    const held = s.store.getState()
    expect(held.state?.phase).toBe('available')
    expect(held.dismissed).toBe('1.2.3')
    expect(held.latest).toBe(true)
  })

  test('announceLatest 之后 clearLatest 能把「已是最新」收回去（报完就清）', () => {
    const s = createUpdateStore()
    s.announceLatest()
    expect(s.store.getState().latest).toBe(true)
    s.clearLatest()
    expect(s.store.getState().latest).toBe(false)
  })

  test('订阅者拿得到每一次变化（横幅与检查行读的是同一份）', () => {
    const s = createUpdateStore()
    const seen: boolean[] = []
    const off = s.store.subscribe((held) => {
      seen.push(held.latest)
    })
    s.announceLatest()
    s.clearLatest()
    off()
    expect(seen).toEqual([true, false])
  })
})
