import { describe, expect, test } from 'bun:test'
import type { ScenarioScript } from '@poietica/engine-testkit'
import { workspacesContract } from '@poietica/feature-workspaces/contract'
import { tempDir } from '@poietica/test-kit'
import { conversationContract } from '../../contract'
import { BUSY_SCRIPT, harness } from './helpers'

/**
 * 模块级集成测试（14 页 §0.4）：用 createCoreHarness 启动只含被测模块及其依赖的真实内核，
 * engine 是 FakeEngine。harness 的时钟是 fakeClock —— FakeEngine 按 12 页 §1.2 用注入的
 * Clock 排下一拍，时间线合批窗口（16ms）也走同一个 clock，所以必须显式推时间。
 */
async function started(script?: ScenarioScript) {
  const { h, engine } = await harness(script === undefined ? {} : { script })
  const api = h.client(conversationContract)
  const dir = await tempDir('conv-')
  const ws = await h.client(workspacesContract).call('workspaces.add', { path: dir.path })
  const thread = await api.call('threads.create', { workspaceId: ws.id })
  const finish = async (): Promise<void> => {
    await h.dispose()
    await dir.dispose()
  }
  return { h, engine, api, dir, ws, thread, finish }
}

/** 推过 FakeEngine 的下一拍 + TimelineChannel 的 16ms 合批窗口 */
const runOneBeat = async (h: Awaited<ReturnType<typeof started>>['h']): Promise<void> => {
  await h.clock.advanceAsync(1)
  await h.clock.advanceAsync(20)
}

/**
 * 把这一轮跑到底：FakeEngine 的每一步都排在下一拍（12 页 §1.2），所以推一次不够。
 * 循环推到线程不再是 running 为止（有上限，免得脚本停不下来时挂住）。
 */
const runToIdle = async (
  h: Awaited<ReturnType<typeof started>>['h'],
  api: Awaited<ReturnType<typeof started>>['api'],
  threadId: string,
): Promise<void> => {
  let seenBusy = false
  for (let i = 0; i < 60; i++) {
    await h.clock.advanceAsync(20)
    const state = (await api.call('threads.get', { threadId })).state
    if (state !== 'idle') seenBusy = true
    // 必须先看见它跑起来再等它停下：submit 之后、下一拍之前读到的也是 'idle'
    else if (seenBusy) {
      // 状态是通过事件送达的，再推两拍确认它稳在 idle（同一轮的收尾挂在下一拍）
      await h.clock.advanceAsync(20)
      await h.clock.advanceAsync(20)
      if ((await api.call('threads.get', { threadId })).state === 'idle') return
    }
  }
}

describe('conversation core 模块', () => {
  test('CV-1 threads.create 后 hasSession 为 false；第一次 turns.submit 后为 true，会话文件已绑定', async () => {
    const { api, thread, h, finish } = await started()
    expect(thread.hasSession).toBe(false)
    expect(thread.state).toBe('idle')
    expect(thread.titleSource).toBe('pending')

    await api.call('turns.submit', {
      threadId: thread.id,
      clientTurnId: 'C1',
      text: '你好',
      attachmentIds: [],
      skills: [],
      deliverAs: 'turn',
    })
    await runOneBeat(h)
    const after = await api.call('threads.get', { threadId: thread.id })
    expect(after.hasSession).toBe(true)
    expect(after.title).toBe('你好')
    expect(after.titleSource).toBe('auto')
    await finish()
  })

  /* CV-3（方案第 7 节改写）：运行中提交 turn 被接受，并转为 followUp（排队）。 */
  test('CV-3 运行中 turns.submit(turn) 被接受并转为排队；steer 与 followUp 也被接受', async () => {
    // 用一个会停在交互上的脚本：这一档的会话稳定是「忙」，不会被下一拍跑完
    const { api, thread, h, finish } = await started(BUSY_SCRIPT)
    await api.call('turns.submit', {
      threadId: thread.id,
      clientTurnId: 'A',
      text: '第一句',
      attachmentIds: [],
      skills: [],
      deliverAs: 'turn',
    })
    // 推过下一拍：FakeEngine 开始跑这一轮，状态变成 running
    await h.clock.advanceAsync(1)
    expect((await api.call('threads.get', { threadId: thread.id })).state).not.toBe('idle')

    const second = await api.call('turns.submit', {
      threadId: thread.id,
      clientTurnId: 'B',
      text: '再来',
      attachmentIds: [],
      skills: [],
      deliverAs: 'turn',
    })
    /* Core 已收下（pending），交接时发现会话在忙会改成排队。 */
    expect(second.submission.status).toBe('pending')

    await api.call('turns.submit', {
      threadId: thread.id,
      clientTurnId: 'C',
      text: '插话',
      attachmentIds: [],
      skills: [],
      deliverAs: 'steer',
    })
    await api.call('turns.submit', {
      threadId: thread.id,
      clientTurnId: 'D',
      text: '排队',
      attachmentIds: [],
      skills: [],
      deliverAs: 'followUp',
    })
    await runOneBeat(h)
    await finish()
  })

  test('CV-4 turn.upsert 携带 clientTurnId（每条都带，界面靠它认轮）', async () => {
    const { api, thread, h, finish } = await started()
    await api.call('turns.submit', {
      threadId: thread.id,
      clientTurnId: 'CLIENT-1',
      text: '你好',
      attachmentIds: [],
      skills: [],
      deliverAs: 'turn',
    })
    await runOneBeat(h)

    const ops = h
      .notifications(conversationContract, 'timeline.ops')
      .flatMap((n) => n.ops as readonly { op: string; turn?: { turnId?: string; clientTurnId?: string } }[])
    const stamped = ops.filter((op) => op.op === 'turn.upsert' && op.turn?.clientTurnId === 'CLIENT-1')
    expect(stamped.length).toBeGreaterThan(0)
    /* 同一 turn 的后续更新也带同一个号：收尾那条会把整条 turn 换掉，缺了界面就判不出真轮。 */
    const turnId = stamped[0]!.turn!.turnId
    const onTurn = ops.filter((op) => op.op === 'turn.upsert' && op.turn?.turnId === turnId)
    expect(onTurn.every((op) => op.turn?.clientTurnId === 'CLIENT-1')).toBe(true)
    await finish()
  })

  test('threads.delete 空闲线程：会话文件被删除、threads.removed 发出', async () => {
    const { api, thread, h, finish } = await started()
    await api.call('turns.submit', {
      threadId: thread.id,
      clientTurnId: 'X',
      text: 'hi',
      attachmentIds: [],
      skills: [],
      deliverAs: 'turn',
    })
    await runToIdle(h, api, thread.id)
    expect((await api.call('threads.get', { threadId: thread.id })).hasSession).toBe(true)
    expect((await api.call('threads.get', { threadId: thread.id })).state).toBe('idle')

    await api.call('threads.delete', { threadId: thread.id })
    expect(h.notifications(conversationContract, 'threads.removed').some((n) => n.threadId === thread.id)).toBe(true)
    const err = await api.call('threads.get', { threadId: thread.id }).catch((e: unknown) => e)
    expect((err as { code?: string }).code).toBe('conversation.thread_not_found')
    await finish()
  })

  test('时间线订阅：没有会话时返回空页，不打开会话', async () => {
    const { api, thread, engine, finish } = await started()
    const snap = await api.call('timeline.subscribe', { threadId: thread.id, agentId: 'main' })
    expect(snap.page.items).toEqual([])
    expect(snap.epoch).toBeGreaterThan(0)
    expect(engine.opened.length).toBe(0)
    await finish()
  })

  test('工作区被移除：该工作区的线程被级联删除', async () => {
    const { api, thread, h, ws, finish } = await started()
    await api.call('turns.submit', {
      threadId: thread.id,
      clientTurnId: 'Y',
      text: 'hi',
      attachmentIds: [],
      skills: [],
      deliverAs: 'turn',
    })
    await runOneBeat(h)
    await h.client(workspacesContract).call('workspaces.remove', { workspaceId: ws.id })
    // 级联是异步的（事件处理器里 void 出去），推一拍让它跑完
    await h.clock.advanceAsync(1)
    await new Promise((r) => setTimeout(r, 20))
    expect(h.notifications(conversationContract, 'threads.removed').some((n) => n.threadId === thread.id)).toBe(true)
    await finish()
  })
})
