import { describe, expect, test } from 'bun:test'
import type { Controls } from '@poietica/engine'
import type { ConversationApi } from '../../api'
import { createControlsStore } from '../controls-store'

/*
 * R-19-4：控件表的主动拉取。
 * 线程表面挂载、点侧栏、Core 就绪后的 resyncVisible、StrictMode 双挂载都会 refresh 同一条对话 ——
 * 进行中的请求要合并；refresh 发出之后又推来一份 controls.changed，旧应答不能把它盖掉。
 */

const table = (tag: string): Controls => ({ tag }) as unknown as Controls

function fakeApi() {
  const pending: { threadId: string; resolve: (c: Controls) => void; reject: (e: unknown) => void }[] = []
  const api = {
    getControls: (threadId: string) =>
      new Promise<Controls>((resolve, reject) => {
        pending.push({ threadId, resolve, reject })
      }),
  } as unknown as ConversationApi
  return { api, pending }
}

describe('controls-store refresh（R-19-4）', () => {
  test('同一条对话进行中的 refresh 合并成一次请求；不同对话各问各的', async () => {
    const { api, pending } = fakeApi()
    const controls = createControlsStore(api)

    const a1 = controls.refresh('a')
    const a2 = controls.refresh('a')
    void controls.refresh('b')
    expect(pending.map((p) => p.threadId)).toEqual(['a', 'b'])

    pending[0]?.resolve(table('a'))
    await Promise.all([a1, a2])
    expect(controls.get('a')).toEqual(table('a'))

    /* 上一次已经落地：再问就是新的一次请求 */
    void controls.refresh('a')
    expect(pending.map((p) => p.threadId)).toEqual(['a', 'b', 'a'])
  })

  test('refresh 在路上时推来了新表：旧应答不覆盖推送', async () => {
    const { api, pending } = fakeApi()
    const controls = createControlsStore(api)

    const request = controls.refresh('a')
    controls.set('a', table('pushed'))
    pending[0]?.resolve(table('stale'))
    await request

    expect(controls.get('a')).toEqual(table('pushed'))
  })

  test('拉取失败记进 failure；之后的推送清掉它', async () => {
    const { api, pending } = fakeApi()
    const controls = createControlsStore(api)

    const request = controls.refresh('a')
    pending[0]?.reject(new Error('会话还没就绪'))
    await request
    expect(controls.failureOf('a')).toBe('会话还没就绪')

    controls.set('a', table('ok'))
    expect(controls.failureOf('a')).toBeUndefined()
  })
})
