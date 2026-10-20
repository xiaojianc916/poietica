import { describe, expect, test } from 'bun:test'
import { workspacesContract } from '@poietica/feature-workspaces/contract'
import { tempDir } from '@poietica/test-kit'
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

/** 工作区只有「真实文件夹」一种：建一个临时目录再加进来。 */
async function addWorkspace(h: Awaited<ReturnType<typeof harness>>['h']) {
  const dir = await tempDir('conv-draft-')
  const workspace = await h.client(workspacesContract).call('workspaces.add', { path: dir.path })
  return { workspace, dir }
}

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

  test('hidden 从 RPC 透传给引擎：只影响兜底，空表仍按目录第一条', async () => {
    const { h, engine } = await harness()
    const api = h.client(conversationContract)
    const seen: Array<readonly string[] | undefined> = []
    const draftControls = engine.draftControls.bind(engine)
    engine.draftControls = async (init) => {
      seen.push(init?.hidden)
      return draftControls(init)
    }

    await api.call('controls.draft', {
      model: null,
      thinking: null,
      posture: null,
      hidden: ['fake/first'],
    })
    await api.call('controls.draft', { model: null, thinking: null, posture: null })

    expect(seen).toEqual([['fake/first'], undefined])

    await h.dispose()
  })
})

describe('CV-14 入口页选好再发送', () => {
  test('选中值带进 threads.create（posture / thinking）', async () => {
    const { h, engine } = await harness()
    const api = h.client(conversationContract)
    const { workspace, dir } = await addWorkspace(h)

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
    await dir.dispose()
  })
})

/*
 * 问题 1 二期：入口页的模型 / 档位写穿「新对话默认」那一份意图（引擎的 `modelRoles.default:档位`），
 * 默认值变更只让入口页重读草稿表，不让会话池换代。
 */
describe('CV-15 入口页写穿新对话默认意图', () => {
  test('controls.setDraft 写进引擎默认意图；controls.draft 不带草稿时读回它', async () => {
    const { h, engine } = await harness()
    const api = h.client(conversationContract)

    await api.call('controls.setDraft', { model: { provider: 'fake', id: 'second' }, thinking: 'high' })
    expect(await engine.models.defaultSelection()).toEqual({
      model: { provider: 'fake', id: 'second' },
      thinking: 'high',
    })
    const draft = await api.call('controls.draft', { model: null, thinking: null, posture: null })
    expect(draft.model.current).toEqual({ provider: 'fake', id: 'second' })
    expect(draft.thinking.current).toBe('high')

    /* 只改档位：model 交 null，Core 解出此刻显示的那条模型 */
    await api.call('controls.setDraft', { model: null, thinking: 'low' })
    expect(await engine.models.defaultSelection()).toEqual({
      model: { provider: 'fake', id: 'second' },
      thinking: 'low',
    })
    /* 只换模型：档位省略 = 保留 */
    await api.call('controls.setDraft', { model: { provider: 'fake', id: 'first' } })
    expect((await engine.models.defaultSelection()).thinking).toBe('low')

    await h.dispose()
  })

  test('没有可显示的模型时只改档位如实报错，不编一条', async () => {
    const { h } = await harness()
    const api = h.client(conversationContract)
    await expect(api.call('controls.setDraft', { model: null, thinking: 'low' })).rejects.toThrow()
    await h.dispose()
  })

  test('默认值变更只发 controls.draftChanged，空闲会话不被换代；目录变更照旧换代', async () => {
    const { h, engine } = await harness()
    const api = h.client(conversationContract)
    const { workspace } = await addWorkspace(h)
    const thread = await api.call('threads.create', { workspaceId: workspace.id })
    await api.call('threads.open', { threadId: thread.id })
    const openedAfterOpen = openedOf(engine).length
    const changedBefore = h.notifications(conversationContract, 'controls.draftChanged').length

    await api.call('controls.setDraft', { model: { provider: 'fake', id: 'second' }, thinking: 'high' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(h.notifications(conversationContract, 'controls.draftChanged').length).toBeGreaterThan(changedBefore)
    /* 会话还在池里：再读控件表不重开 */
    await api.call('controls.get', { threadId: thread.id })
    expect(openedOf(engine).length).toBe(openedAfterOpen)

    /* 对照：目录变了（启停模型）仍让空闲会话换代，下一次读控件表要重开 */
    await engine.models.setModelEnabled({ provider: 'fake', id: 'second' }, false)
    await new Promise((resolve) => setTimeout(resolve, 20))
    await api.call('controls.get', { threadId: thread.id })
    expect(openedOf(engine).length).toBe(openedAfterOpen + 1)

    await h.dispose()
  })
})
