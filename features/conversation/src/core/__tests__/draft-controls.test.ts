import { describe, expect, test } from 'bun:test'
import { workspacesContract } from '@poietica/feature-workspaces/contract'
import { conversationContract } from '../../contract'
import { harness } from './helpers'

/*
 * CV-13 / CV-14（方案 §04–§07 的入口页草稿选择）。
 *
 * 入口页还没有 threadId，所以它没有会话级控件表可改：`controls.draft` 读一份**草稿**
 * 表（只读、不开会话、不写设置），用户在那里改的几格只存在入口页本地；发送时由
 * `threads.create` 的 ThreadInit 把选中的三格带进新线程。
 *
 * 会话桩：`h.client(contract).call(...)`（见 module.test.ts 的用法）。
 */
const openedOf = (engine: unknown): readonly { posture?: string; thinking?: string | null }[] =>
  (engine as { opened: readonly { posture?: string; thinking?: string | null }[] }).opened

describe('CV-13 草稿控件表', () => {
  test('controls.draft 不开会话，默认姿态是 auto-edit', async () => {
    const { h, engine } = await harness()
    const api = h.client(conversationContract)
    const openedBefore = openedOf(engine).length

    const controls = await api.call('controls.draft', { model: null, thinking: null, posture: null })

    /* 只读：一条会话都没有开（方案 §04「只读，不开会话，不写文件，也不写设置」）。 */
    expect(openedOf(engine).length).toBe(openedBefore)
    expect(controls.posture).toBe('auto-edit')
    expect(controls.planMode).toBe(false)
    expect(controls.goal).toBeNull()
    expect(controls.context).toBeNull()

    await h.dispose()
  })

  test('草稿给的三格原样回显（入口页改了什么，读回来就是什么）', async () => {
    const { h } = await harness()
    const api = h.client(conversationContract)

    const controls = await api.call('controls.draft', {
      model: { provider: 'fake', id: 'first' },
      posture: 'full-access',
      thinking: 'low',
    })

    expect(controls.posture).toBe('full-access')
    expect(controls.thinking.current).toBe('low')

    await h.dispose()
  })
})

describe('CV-14 入口页选好再发送', () => {
  test('选中值带进 threads.create（posture / thinking）', async () => {
    const { h, engine } = await harness()
    const api = h.client(conversationContract)
    const workspace = await h.client(workspacesContract).call('workspaces.createScratch', {})

    const thread = await api.call('threads.create', {
      workspaceId: workspace.id,
      posture: 'full-access',
      thinking: 'low',
    })

    /* 线程行带上选中的姿态（07 页 §5C 的 threads.create）。 */
    expect(thread.posture).toBe('full-access')

    /*
     * 开场会话时 describe() 把初始姿态与档位交给引擎 —— 这才是「入口页选好再发送」
     * 的落点：不是发一条 set 消息，而是新线程一开始就在那一档上。
     */
    await api.call('threads.open', { threadId: thread.id })
    const opened = openedOf(engine).at(-1)
    expect(opened?.posture).toBe('full-access')
    expect(opened?.thinking).toBe('low')

    await h.dispose()
  })
})
