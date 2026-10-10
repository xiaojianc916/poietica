import { describe, expect, test } from 'bun:test'
import { workspacesContract } from '@poietica/feature-workspaces/contract'
import { conversationContract } from '../../contract'
import { harness } from './helpers'

/*
 * 审查 R-10：目标栏的暂停 / 继续 / 改正文以前在 UI 那一层就被丢掉了（只有「清除」下发），
 * Core 与引擎端口也没有暂停 / 继续这两个入口。这里钉住整条链：RPC → handlers → TurnService
 * → EngineSession（FakeEngine），以及 UI 真正依赖的那条 controls.changed 通知。
 */
async function openThread() {
  const { h } = await harness()
  const api = h.client(conversationContract)
  const workspace = await h.client(workspacesContract).call('workspaces.createScratch', {})
  const thread = await api.call('threads.create', { workspaceId: workspace.id })
  const lastChanged = () =>
    h
      .notifications(conversationContract, 'controls.changed')
      .filter((n) => n.threadId === thread.id)
      .at(-1)?.controls
  return { h, api, threadId: thread.id, lastChanged }
}

describe('R-10 目标动作经 RPC 下到会话', () => {
  test('设 → 暂停 → 改正文（仍暂停）→ 继续 → 清除：返回的控件表与 controls.changed 一步步跟着走', async () => {
    const { h, api, threadId, lastChanged } = await openThread()

    const set = await api.call('controls.setGoal', { threadId, goal: '把测试迁完' })
    expect(set.goalSnapshot).toMatchObject({ objective: '把测试迁完', status: 'active' })

    const paused = await api.call('controls.pauseGoal', { threadId })
    expect(paused.goalSnapshot).toMatchObject({ objective: '把测试迁完', status: 'paused' })
    expect(lastChanged()?.goalSnapshot?.status).toBe('paused')

    const edited = await api.call('controls.setGoal', { threadId, goal: '把测试迁完并补文档' })
    expect(edited.goalSnapshot).toMatchObject({ objective: '把测试迁完并补文档', status: 'paused' })

    const resumed = await api.call('controls.resumeGoal', { threadId })
    expect(resumed.goalSnapshot).toMatchObject({ objective: '把测试迁完并补文档', status: 'active' })
    expect(lastChanged()?.goalSnapshot?.status).toBe('active')

    const cleared = await api.call('controls.setGoal', { threadId, goal: null })
    expect(cleared.goal).toBeNull()
    expect(cleared.goalSnapshot).toBeNull()
    expect(lastChanged()?.goalSnapshot).toBeNull()

    await h.dispose()
  })

  test('没有目标时暂停 / 继续：以 kernel.not_found 拒绝，message 是给人看的那句话', async () => {
    const { h, api, threadId } = await openThread()

    const pauseError = await api.call('controls.pauseGoal', { threadId }).catch((e: unknown) => e)
    expect((pauseError as { code?: string }).code).toBe('kernel.not_found')
    expect((pauseError as Error).message).toBe('这条对话没有进行中的目标')

    const resumeError = await api.call('controls.resumeGoal', { threadId }).catch((e: unknown) => e)
    expect((resumeError as { code?: string }).code).toBe('kernel.not_found')
    expect((resumeError as Error).message).toBe('这条对话没有已暂停的目标')

    await h.dispose()
  })
})
