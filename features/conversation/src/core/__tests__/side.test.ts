import { describe, expect, test } from 'bun:test'
import { say } from '@poietica/engine-testkit'
import { workspacesContract } from '@poietica/feature-workspaces/contract'
import { AppError } from '@poietica/foundation'
import { tempDir } from '@poietica/test-kit'
import { conversationContract } from '../../contract'
import { BUSY_SCRIPT, harness } from './helpers'

/**
 * 侧边提问（右坞「辅助对话」）的 Core 一侧：side.* 三个方法、三条通知，以及它与主对话互不牵连。
 * 引擎是 FakeEngine：侧边一问按脚本的 text / fail 步骤作答（turnIndex = SIDE_TURN_INDEX），每一截隔一拍。
 */
async function started(opts: Parameters<typeof harness>[0] = {}) {
  const { h, engine } = await harness(opts)
  const api = h.client(conversationContract)
  const dir = await tempDir('side-')
  const ws = await h.client(workspacesContract).call('workspaces.add', { path: dir.path })
  const thread = await api.call('threads.create', { workspaceId: ws.id })
  const finish = async (): Promise<void> => {
    await h.dispose()
    await dir.dispose()
  }
  return { h, engine, api, thread, finish }
}

const settle = async (h: Awaited<ReturnType<typeof started>>['h']): Promise<void> => {
  for (let i = 0; i < 10; i++) await h.clock.advanceAsync(5)
}

const codeOf = (e: unknown): string => (e instanceof AppError ? e.code : String(e))

describe('side.*（侧边提问）', () => {
  test('side.list：从没落过盘的对话返回空表，且不为它开会话', async () => {
    const { api, thread, finish } = await started()
    expect((await api.call('side.list', { threadId: thread.id })).topics).toEqual([])
    expect((await api.call('threads.get', { threadId: thread.id })).hasSession).toBe(false)
    await finish()
  })

  test('side.ask：开问即返回 running 快照；delta 按 offset 首尾相接，side.topic 收口为 complete', async () => {
    const { h, api, thread, finish } = await started({ script: () => [say('先说'), say('结论')] })
    const { topic } = await api.call('side.ask', {
      threadId: thread.id,
      question: '  这段代码在干嘛？ ',
      topicId: null,
    })
    expect(topic.turns).toHaveLength(1)
    expect(topic.turns[0]).toMatchObject({ question: '这段代码在干嘛？', answer: '', status: 'running' })
    await settle(h)

    const deltas = h.notifications(conversationContract, 'side.delta').filter((n) => n.topicId === topic.id)
    expect(deltas.map((d) => d.offset)).toEqual([0, 2])
    expect(deltas.map((d) => d.delta).join('')).toBe('先说结论')
    const snapshots = h.notifications(conversationContract, 'side.topic').filter((n) => n.topic.id === topic.id)
    expect(snapshots.at(-1)?.topic.turns[0]).toMatchObject({ answer: '先说结论', status: 'complete' })

    /* 侧边一问不进时间线、不改主对话状态 */
    expect((await api.call('threads.get', { threadId: thread.id })).state).toBe('idle')
    const listed = (await api.call('side.list', { threadId: thread.id })).topics
    expect(listed.map((t) => t.id)).toEqual([topic.id])

    /* 追问接在同一个话题后面 */
    const followUp = await api.call('side.ask', { threadId: thread.id, question: '再细一点', topicId: topic.id })
    expect(followUp.topic.id).toBe(topic.id)
    expect(followUp.topic.turns.map((t) => t.status)).toEqual(['complete', 'running'])
    await settle(h)
    const latest = (await api.call('side.list', { threadId: thread.id })).topics[0]
    expect(latest?.turns.map((t) => t.status)).toEqual(['complete', 'complete'])
    await finish()
  })

  test('同一时刻只答一问；side.cancel 停掉它，再停一次报 false', async () => {
    const { h, api, thread, finish } = await started({ script: () => [say('一'), say('二'), say('三')] })
    /* 不推时钟：答案从下一拍起才流出，此刻这一问还在答 */
    const { topic } = await api.call('side.ask', { threadId: thread.id, question: '问一', topicId: null })
    const busy = await api.call('side.ask', { threadId: thread.id, question: '问二', topicId: null }).catch((e) => e)
    expect(codeOf(busy)).toBe('engine.side_busy')

    expect((await api.call('side.cancel', { threadId: thread.id, topicId: topic.id })).cancelled).toBe(true)
    expect((await api.call('side.cancel', { threadId: thread.id, topicId: null })).cancelled).toBe(false)
    await settle(h)
    const turn = (await api.call('side.list', { threadId: thread.id })).topics[0]?.turns[0]
    expect(turn?.status).toBe('cancelled')
    /* 停掉之后脚本里剩下的几截不再流出 */
    expect(h.notifications(conversationContract, 'side.delta').filter((n) => n.topicId === topic.id)).toEqual([])
    await finish()
  })

  test('参数与话题：空白问题判参数无效，不认识的话题抛 engine.side_topic_unknown', async () => {
    const { api, thread, finish } = await started()
    const blank = await api.call('side.ask', { threadId: thread.id, question: '   ', topicId: null }).catch((e) => e)
    expect(codeOf(blank)).toBe('kernel.invalid_params')
    const unknown = await api
      .call('side.ask', { threadId: thread.id, question: '接着问', topicId: 'side-nope' })
      .catch((e) => e)
    expect(codeOf(unknown)).toBe('engine.side_topic_unknown')
    await finish()
  })

  test('主对话停在交互上（忙）也能问；此时删除仍被主轮拦住', async () => {
    const { h, api, thread, finish } = await started({
      script: (_input, turnIndex) => (turnIndex < 0 ? [say('侧边答')] : BUSY_SCRIPT(_input, turnIndex)),
    })
    await api.call('turns.submit', {
      threadId: thread.id,
      clientTurnId: 'C1',
      text: '主对话',
      attachmentIds: [],
      skills: [],
      deliverAs: 'turn',
    })
    await settle(h)
    expect((await api.call('threads.get', { threadId: thread.id })).state).toBe('awaiting')
    const { topic } = await api.call('side.ask', { threadId: thread.id, question: '顺便问', topicId: null })
    expect(topic.turns[0]?.status).toBe('running')
    /* 主对话还停在交互上：删除被拦的理由是主轮，不是侧边 */
    const blocked = await api.call('threads.delete', { threadId: thread.id }).catch((e) => e)
    expect(codeOf(blocked)).toBe('conversation.thread_busy')
    await finish()
  })

  test('只有侧边一问在答：删除照常进行', async () => {
    const { h, api, thread, finish } = await started({ script: () => [say('慢'), say('慢地答')] })
    await api.call('turns.submit', {
      threadId: thread.id,
      clientTurnId: 'C1',
      text: '先落个盘',
      attachmentIds: [],
      skills: [],
      deliverAs: 'turn',
    })
    await settle(h)
    expect((await api.call('threads.get', { threadId: thread.id })).state).toBe('idle')
    await api.call('side.ask', { threadId: thread.id, question: '顺便问', topicId: null })
    await api.call('threads.delete', { threadId: thread.id })
    expect(h.notifications(conversationContract, 'threads.removed').some((n) => n.threadId === thread.id)).toBe(true)
    await finish()
  })
})
