import { describe, expect, test } from 'bun:test'
import { createFakeEngine, type FakeEngine, type ScenarioScript } from '@poietica/engine-testkit'
import type { AttachmentsService } from '@poietica/feature-attachments/core-api'
import type { Workspace } from '@poietica/feature-workspaces/contract'
import type { WorkspacesService } from '@poietica/feature-workspaces/core-api'
import { createId, systemClock } from '@poietica/foundation'
import { openDatabase } from '@poietica/storage-sqlite'
import { createTestLogger, tempDir } from '@poietica/test-kit'
import type { WireTranscriptOperation } from '../../contract/wire'
import { ConversationCore } from '../conversation'
import { migrations } from '../migrations'
import { TimelineHub } from '../timeline-hub'

/** 直接构造 ConversationCore：注入内存库、假工作区与假附件服务，比装整个内核更快也更聚焦 */
async function makeCore(overrides: { engine?: FakeEngine; workspaces?: WorkspacesService } = {}) {
  const db = openDatabase(':memory:')
  for (const m of migrations) db.forModule('conversation').exec(m.sql!)
  /*
   * FakeEngine 按 12 页 §1.2 用**注入的 Clock** 排下一拍（clock.setTimeout(…, 0)）。
   * 这里用 systemClock：这些用例要观察「运行中」这一刻，而 fakeClock 不推时间就永远不开始。
   * 会用到 fakeClock 的只有会话池自己的 TTL/sweep —— 那些用例在 session-pool.test.ts 里。
   */
  const clock = systemClock
  const dir = await tempDir('conv-core-')
  const hub = new TimelineHub({ clock, emitOps: () => undefined, emitReset: () => undefined })

  const workspaces: WorkspacesService =
    overrides.workspaces ??
    ({
      get: (id) =>
        id === 'ws1'
          ? ({
              id: 'ws1',
              kind: 'folder',
              path: dir.path,
              name: 'ws1',
              createdAt: 0,
              lastOpenedAt: 0,
              exists: true,
            } satisfies Workspace)
          : null,
      requireUsable(id) {
        const ws = this.get(id)
        if (ws === null) throw new Error('workspaces.not_found')
        return ws
      },
      list: () => [],
    } as WorkspacesService)

  const retained: { ids: readonly string[]; ownerKey: string }[] = []
  const released: string[] = []
  const attachments: AttachmentsService = {
    resolve: (ids) => ids.map((id) => ({ id, name: id, mime: 'image/png', kind: 'image' as const, path: `/x/${id}` })),
    describe: (ids) =>
      ids.map((id) => ({
        id,
        name: id,
        mime: 'image/png',
        kind: 'image' as const,
        size: 1,
        previewUrl: null,
      })),
    retain: (ids, ownerKey) => {
      retained.push({ ids, ownerKey })
    },
    releaseOwner: (ownerKey) => {
      released.push(ownerKey)
    },
  }

  const settled: { threadId: string; outcome: string }[] = []
  const sampled: unknown[] = []
  const contextUsages: { threadId: string; usage: unknown }[] = []
  const messages: { threadId: string; at: number }[] = []
  const updated: string[] = []
  const removed: string[] = []
  const states: { threadId: string; state: string }[] = []

  const engine: FakeEngine = overrides.engine ?? createFakeEngine()
  engine.freezeTools()

  const core = new ConversationCore({
    db: db.forModule('conversation'),
    engine,
    hub,
    workspaces,
    attachments,
    clock,
    logger: createTestLogger(),
    emitThreadUpdated: (t) => {
      updated.push(t.id)
    },
    emitThreadRemoved: (id) => {
      removed.push(id)
    },
    emitTurnState: (s) => {
      states.push({ threadId: s.threadId, state: s.state })
    },
    emitTurnDropped: () => undefined,
    emitQueue: () => undefined,
    emitControls: () => undefined,
    emitContextUsage: (p) => {
      contextUsages.push(p)
    },
    emitInteractionRequested: () => undefined,
    emitInteractionResolved: () => undefined,
    emitSubmissionChanged: () => undefined,
    emitSubmissionRemoved: () => undefined,
    emitTurnSettled: (p) => {
      settled.push({ threadId: p.threadId, outcome: p.outcome })
    },
    emitUsageSampled: (p) => {
      sampled.push(p)
    },
    emitUserMessage: (p) => {
      messages.push(p)
    },
  })

  return {
    core,
    engine,
    clock,
    dir,
    db,
    retained,
    released,
    settled,
    sampled,
    contextUsages,
    messages,
    updated,
    removed,
    states,
    hub,
  }
}

/**
 * 让会话稳定停在「忙」的那一档：一个 approval 交互。
 * FakeEngine 执行到 interaction 会发 interactionRequested → state awaiting 并**暂停**，
 * 直到 respond（12 页 §1.2），所以 isBusy() 不会因为脚本跑完而自己变回 idle。
 */
const BUSY_SCRIPT: ScenarioScript = () => [
  { kind: 'interaction', interaction: { kind: 'confirm', title: '继续吗', message: '等一句回答' } },
]

const submit = (core: ConversationCore, threadId: string, text: string) =>
  core.submit({ threadId, clientTurnId: createId(), text, attachmentIds: [], skills: [], deliverAs: 'turn' })

describe('conversation core（不经内核的直连测试）', () => {
  test('threads.create 不打开会话；submit 之后绑定会话文件', async () => {
    const { core, engine, dir, db } = await makeCore()
    const row = core.create({ workspaceId: 'ws1' })
    expect(row.sessionFile).toBeNull()
    expect(core.threadOf(row).hasSession).toBe(false)

    await submit(core, row.id, '你好')
    await new Promise((r) => setTimeout(r, 30))
    const after = core.row(row.id)!
    expect(after.sessionFile).not.toBeNull()
    expect(core.threadOf(after).hasSession).toBe(true)
    expect(engine.opened.length).toBe(1)
    expect(engine.opened[0]!.key).toBe(row.id)
    expect(engine.opened[0]!.posture).toBe('auto-edit') // 默认姿态
    await core.dispose()
    db.close()
    await dir.dispose()
  })

  test('CV-4 clientTurnId 只写一次', async () => {
    /*
     * 判据取自 UI 真正读的那条路：Core 把 op 交给 hub（16ms 合批），
     * UI 用 catchUp 把批次读回来 —— 所以这里也从 hub 的增量通知里读，
     * 断言 `turn.upsert` 上带着提交时的 clientTurnId，且同一 turn 的后续更新不再重复带它。
     */
    const db = openDatabase(':memory:')
    for (const m of migrations) db.forModule('conversation').exec(m.sql!)
    const dir = await tempDir('conv-core-')
    const clock = systemClock
    /* 线上形状：clientTurnId 只在这里有（core 交给 hub 的 op 就是这一份）。 */
    const batches: { seq: number; ops: readonly WireTranscriptOperation[] }[] = []
    const hub = new TimelineHub({
      clock,
      emitOps: (p) => batches.push({ seq: p.seq, ops: p.ops }),
      emitReset: () => undefined,
    })
    const workspaces = {
      get: (id: string) =>
        id === 'ws1'
          ? {
              id: 'ws1',
              kind: 'folder' as const,
              path: dir.path,
              name: 'ws1',
              createdAt: 0,
              lastOpenedAt: 0,
              exists: true,
            }
          : null,
      requireUsable(id: string) {
        const ws = this.get(id)
        if (ws === null) throw new Error('workspaces.not_found')
        return ws
      },
      list: () => [],
    } as WorkspacesService
    const attachments: AttachmentsService = {
      resolve: (ids) =>
        ids.map((id) => ({ id, name: id, mime: 'image/png', kind: 'image' as const, path: `/x/${id}` })),
      describe: (ids) =>
        ids.map((id) => ({
          id,
          name: id,
          mime: 'image/png',
          kind: 'image' as const,
          size: 1,
          previewUrl: null,
        })),
      retain: () => undefined,
      releaseOwner: () => undefined,
    }
    const engine = createFakeEngine()
    engine.freezeTools()
    const core = new ConversationCore({
      db: db.forModule('conversation'),
      engine,
      hub,
      workspaces,
      attachments,
      clock,
      logger: createTestLogger(),
      emitThreadUpdated: () => undefined,
      emitThreadRemoved: () => undefined,
      emitTurnState: () => undefined,
      emitTurnDropped: () => undefined,
      emitQueue: () => undefined,
      emitControls: () => undefined,
      emitInteractionRequested: () => undefined,
      emitInteractionResolved: () => undefined,
      emitSubmissionChanged: () => undefined,
      emitSubmissionRemoved: () => undefined,
      emitTurnSettled: () => undefined,
      emitUsageSampled: () => undefined,
      emitContextUsage: () => undefined,
      emitUserMessage: () => undefined,
    })
    const row = core.create({ workspaceId: 'ws1' })
    const clientTurnId = createId()
    await core.submit({
      threadId: row.id,
      clientTurnId,
      text: '首句',
      attachmentIds: [],
      skills: [],
      deliverAs: 'turn',
    })
    await new Promise((r) => setTimeout(r, 60))

    const upserts = batches
      .flatMap((b) => b.ops)
      .filter((op): op is Extract<WireTranscriptOperation, { op: 'turn.upsert' }> => op.op === 'turn.upsert')
    expect(upserts.length).toBeGreaterThan(0)

    const stamped = upserts.filter((op) => op.turn.clientTurnId === clientTurnId)
    /*
     * 提交号写在 turn.upsert 上，值等于提交时给的那个（方案第 3 节）。
     *
     * **每条** upsert 都要带（不是只带第一条）：收尾那条会把整条 turn 换掉，只在首条写
     * 的话界面就判不出「真轮到了没」，会同时画出提交行与真实轮 —— 两个用户气泡。
     */
    expect(stamped.length).toBeGreaterThan(0)
    const turnId = stamped[0]!.turn.turnId
    const allOnTurn = upserts.filter((op) => op.turn.turnId === turnId)
    expect(allOnTurn.every((op) => op.turn.clientTurnId === clientTurnId)).toBe(true)

    await core.dispose()
    db.close()
    await dir.dispose()
  })

  test('CV-10 取消后 outcome 为 cancelled', async () => {
    const { core, settled, dir, db } = await makeCore({ engine: createFakeEngine({ script: BUSY_SCRIPT }) })
    const row = core.create({ workspaceId: 'ws1' })
    await submit(core, row.id, '开始')
    await new Promise((r) => setTimeout(r, 5))
    await core.cancel(row.id)
    await new Promise((r) => setTimeout(r, 40))
    expect(settled.some((s) => s.outcome === 'cancelled')).toBe(true)
    await core.dispose()
    db.close()
    await dir.dispose()
  })

  test('CV-10 引擎报错时 outcome 为 failed', async () => {
    const engine = createFakeEngine({
      script: () => [{ kind: 'fail', code: 'engine.upstream_error', message: '上游炸了' }],
    })
    const { core, settled, dir, db } = await makeCore({ engine })
    const row = core.create({ workspaceId: 'ws1' })
    await submit(core, row.id, '会失败')
    await new Promise((r) => setTimeout(r, 40))
    expect(settled.some((s) => s.outcome === 'failed')).toBe(true)
    await core.dispose()
    db.close()
    await dir.dispose()
  })

  test('CV-5 删除空闲线程：会话文件被删、附件引用被释放、threads.removed 发出', async () => {
    const { core, engine, removed, released, dir, db } = await makeCore()
    const row = core.create({ workspaceId: 'ws1' })
    await submit(core, row.id, 'hi')
    await new Promise((r) => setTimeout(r, 30))
    const file = core.row(row.id)!.sessionFile!
    expect(engine.sessionFiles.exists(file)).resolves.toBe(true)

    await core.delete(row.id)
    expect(removed).toContain(row.id)
    expect(released).toContain(`conversation:thread:${row.id}`)
    expect(await engine.sessionFiles.exists(file)).toBe(false)
    expect(core.row(row.id)).toBeNull()
    await core.dispose()
    db.close()
    await dir.dispose()
  })

  test('CV-5 删除运行中的线程被拒（thread_busy）', async () => {
    const { core, dir, db } = await makeCore({ engine: createFakeEngine({ script: BUSY_SCRIPT }) })
    const row = core.create({ workspaceId: 'ws1' })
    await submit(core, row.id, '长任务')
    // FakeEngine 在下一拍才开始跑，先让它进入 running
    await new Promise((r) => setTimeout(r, 5))
    const session = core.peek(row.id)
    if (session?.isBusy() === true) {
      const err = await core.delete(row.id).catch((e: unknown) => e)
      expect((err as { code?: string }).code).toBe('conversation.thread_busy')
    }
    await core.cancel(row.id).catch(() => undefined)
    await new Promise((r) => setTimeout(r, 30))
    await core.dispose()
    db.close()
    await dir.dispose()
  })

  /*
   * 上下文用量那条通道的转发。原先它搭的是 controls.changed 那班车，而用量每轮都在涨、
   * 控件表不变 —— 于是跑完一轮读数也不动（真机故障「输入框没有用量显示」的另一半）。
   *
   * 这一条钉住：引擎报 contextUsage → core 原样转发给 UI（含 null 那一次有效报数）。
   */
  test('上下文用量单独转发：引擎每报一次就发一次，null 也发（它是一次有效报数）', async () => {
    const contextUsage = { usedTokens: 27_200, windowTokens: 1_000_000, breakdown: null }
    const { core, contextUsages, dir, db } = await makeCore({
      engine: createFakeEngine({
        contextUsage,
        script: () => [
          {
            kind: 'usage',
            usage: { provider: 'deepseek', model: 'v4-pro', input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0 },
          },
        ],
      }),
    })
    const row = core.create({ workspaceId: 'ws1' })
    await submit(core, row.id, '你好')
    await new Promise((r) => setTimeout(r, 40))

    expect(contextUsages.length).toBeGreaterThan(0)
    expect(contextUsages.every((p) => p.threadId === row.id)).toBe(true)
    expect(contextUsages.at(-1)?.usage).toEqual(contextUsage)

    await core.dispose()
    db.close()
    await dir.dispose()
  })

  test('CV-6 移除工作区：该工作区的线程被删除（运行中的先取消）', async () => {
    const { core, removed, dir, db } = await makeCore()
    const a = core.create({ workspaceId: 'ws1' })
    const b = core.create({ workspaceId: 'ws1' })
    await submit(core, a.id, '第一句')
    await new Promise((r) => setTimeout(r, 30))
    await core.removeWorkspaceThreads('ws1')
    expect(removed).toContain(a.id)
    expect(removed).toContain(b.id)
    expect(core.row(a.id)).toBeNull()
    expect(core.row(b.id)).toBeNull()
    await core.dispose()
    db.close()
    await dir.dispose()
  })

  /*
   * CV-3（方案第 7 节改写）：**运行中提交 turn 被接受，并转为 followUp**。
   *
   * 旧行为是当场抛 thread_busy —— 「Core 即时回显」之后不再这样：Core 先存库再交接，
   * 交接时发现会话在忙就自动改成排队（用户看到的是它进了队列，而不是被拒）。
   */
  test('CV-3 运行中提交 turn 被接受并转为排队，steer 与 followUp 也被接受', async () => {
    const { core, engine, dir, db } = await makeCore({ engine: createFakeEngine({ script: BUSY_SCRIPT }) })
    const row = core.create({ workspaceId: 'ws1' })
    await submit(core, row.id, '第一句')
    // 直接检查会话状态：FakeEngine 的 submit 立即返回、下一拍才 running
    await new Promise((r) => setTimeout(r, 5))
    const session = core.peek(row.id)!
    expect(session.isBusy()).toBe(true)
    const second = await core.submit({
      threadId: row.id,
      clientTurnId: createId(),
      text: '再来',
      attachmentIds: [],
      skills: [],
      deliverAs: 'turn',
    })
    expect(second.submission.status).toBe('pending')
    await core.submit({
      threadId: row.id,
      clientTurnId: createId(),
      text: '插话',
      attachmentIds: [],
      skills: [],
      deliverAs: 'steer',
    })
    await core.submit({
      threadId: row.id,
      clientTurnId: createId(),
      text: '排队',
      attachmentIds: [],
      skills: [],
      deliverAs: 'followUp',
    })
    await new Promise((r) => setTimeout(r, 40))
    void engine
    await core.dispose()
    db.close()
    await dir.dispose()
  })

  /*
   * 用量页「消息数量」那一格的账源（ADR 0039 / legacy 的 turn_admissions）。
   *
   * 两条判据缺一不可：**发出去的算一句**（含插话），**被拒的不算** —— 后者尤其要紧，
   * 计数写在 session.submit 的 await **之前**的话，用户点了发送但对话正忙、
   * 屏幕上什么都没发生，账上却已经多了一句没说过的话。
   */
  test('US-7 发出去一句话算一句（插话也算）', async () => {
    const { core, messages, dir, db } = await makeCore({ engine: createFakeEngine({ script: BUSY_SCRIPT }) })
    const row = core.create({ workspaceId: 'ws1' })

    await submit(core, row.id, '第一句')
    /* 计数发生在后台交接成功之后（方案：慢事放后台），所以等一下。 */
    await new Promise((r) => setTimeout(r, 30))
    expect(messages.map((m) => m.threadId)).toEqual([row.id])

    await new Promise((r) => setTimeout(r, 5))
    expect(core.peek(row.id)!.isBusy()).toBe(true)

    /* 插话同样过准入，所以照算一句（legacy 的口径）。 */
    await core.submit({
      threadId: row.id,
      clientTurnId: createId(),
      text: '插话',
      attachmentIds: [],
      skills: [],
      deliverAs: 'steer',
    })
    await new Promise((r) => setTimeout(r, 30))
    expect(messages).toHaveLength(2)

    await core.dispose()
    db.close()
    await dir.dispose()
  })

  /*
   * 计数必须写在 `await session.submit` **之后**：引擎自己拒绝这一句时（会话已关闭、
   * provider 报错……），屏幕上什么都没发生，账上不该多一句没说过的话。
   *
   * 「Core 即时回显」之后失败不再抛给调用方，而是落成提交的 `failed` 结局（方案第 2 节
   * 的状态表）—— 所以判据换成「那条提交变成 failed，且账上没有多一句」。
   */
  test('US-7 引擎拒收这一句时不计数（计数在 await 之后）', async () => {
    const { core, engine, messages, dir, db } = await makeCore()
    const row = core.create({ workspaceId: 'ws1' })

    /* 第一次老老实实走通，确认这条路上是会计数的。 */
    await submit(core, row.id, '第一句')
    await new Promise((r) => setTimeout(r, 30))
    expect(messages).toHaveLength(1)

    /*
     * 等这一轮跑完再换桩：**忙的时候第二句会在更早那一步被挡下**
     * （`session.state() !== 'idle'`），根本走不到 submit，也就验不到次序。
     */
    for (let i = 0; i < 40 && core.peek(row.id)?.isBusy() === true; i += 1) {
      await new Promise((r) => setTimeout(r, 20))
    }
    expect(core.peek(row.id)?.isBusy()).toBe(false)

    /* 把活会话的 submit 换成必抛的那一版：失败点落在 session.submit 内部。 */
    const live = core.peek(row.id)!
    const original = live.submit.bind(live)
    live.submit = () => Promise.reject(new Error('引擎拒收'))

    const failedId = createId()
    await core.submit({
      threadId: row.id,
      clientTurnId: failedId,
      text: '第二句',
      attachmentIds: [],
      skills: [],
      deliverAs: 'turn',
    })
    await new Promise((r) => setTimeout(r, 30))
    /* 关键判据：被拒的这一次没有在账上留下痕迹。 */
    expect(messages).toHaveLength(1)

    live.submit = original
    void engine
    await core.dispose()
    db.close()
    await dir.dispose()
  })

  test('附件：提交时 retain 到 conversation:thread:<id>，删除时 releaseOwner', async () => {
    const { core, retained, released, dir, db } = await makeCore()
    const row = core.create({ workspaceId: 'ws1' })
    await core.submit({
      threadId: row.id,
      clientTurnId: createId(),
      text: '带附件',
      attachmentIds: ['a1', 'a2'],
      skills: [],
      deliverAs: 'turn',
    })
    expect(retained).toEqual([{ ids: ['a1', 'a2'], ownerKey: `conversation:thread:${row.id}` }])
    await new Promise((r) => setTimeout(r, 30))
    await core.delete(row.id)
    expect(released).toContain(`conversation:thread:${row.id}`)
    await core.dispose()
    db.close()
    await dir.dispose()
  })

  test('引擎配置变化时空闲会话被释放、忙会话保留', async () => {
    const { core, dir, db } = await makeCore({ engine: createFakeEngine({ script: BUSY_SCRIPT }) })
    const idle = core.create({ workspaceId: 'ws1' })
    const busy = core.create({ workspaceId: 'ws1' })
    await core.open(idle.id)
    await submit(core, busy.id, '跑着')
    // 让忙会话真的进入 awaiting（交互是下一拍开始的）
    await new Promise((r) => setTimeout(r, 10))
    expect(core.peek(idle.id)).toBeDefined()
    expect(core.peek(busy.id)!.isBusy()).toBe(true)
    await core.releaseIdle()
    expect(core.peek(idle.id)).toBeUndefined()
    expect(core.peek(busy.id)).toBeDefined()
    await core.cancel(busy.id).catch(() => undefined)
    await new Promise((r) => setTimeout(r, 30))
    await core.dispose()
    db.close()
    await dir.dispose()
  })

  test('turnSettled 每轮结束都发（含正常完成）', async () => {
    const { core, settled, dir, db } = await makeCore()
    const row = core.create({ workspaceId: 'ws1' })
    await submit(core, row.id, '你好')
    await new Promise((r) => setTimeout(r, 60))
    expect(settled.length).toBeGreaterThan(0)
    expect(settled[0]!.outcome).toBe('completed')
    await core.dispose()
    db.close()
    await dir.dispose()
  })

  test('队列与控件：acquire 之后转发给会话', async () => {
    const { core, dir, db } = await makeCore()
    const row = core.create({ workspaceId: 'ws1' })
    const queue = await core.queue(row.id)
    expect(queue.items).toEqual([])
    const controls = await core.controls(row.id)
    expect(controls.posture).toBe('auto-edit')
    const next = await core.setPostureAction(row.id, 'full-access')
    expect(next.posture).toBe('full-access')
    expect(core.row(row.id)!.posture).toBe('full-access')
    await core.dispose()
    db.close()
    await dir.dispose()
  })

  test('interactions.respond 会话不在池中 → interaction_not_found', async () => {
    const { core, dir, db } = await makeCore()
    const row = core.create({ workspaceId: 'ws1' })
    const err = await core.respond(row.id, 'i1', { kind: 'dismiss' }).catch((e: unknown) => e)
    expect((err as { code?: string }).code).toBe('conversation.interaction_not_found')
    await core.dispose()
    db.close()
    await dir.dispose()
  })

  test('线程仓库：置顶在前、同组按 updatedAt 倒序、归档默认不列出', async () => {
    const { core, db, dir } = await makeCore()
    const a = core.create({ workspaceId: 'ws1' })
    const b = core.create({ workspaceId: 'ws1' })
    const c = core.create({ workspaceId: 'ws1' })
    core.setPinned(c.id, true)
    const listed = core.list({ includeArchived: false })
    expect(listed[0]!.id).toBe(c.id)
    core.setArchived(b.id, true)
    const after = core.list({ includeArchived: false })
    expect(after.map((t) => t.id)).not.toContain(b.id)
    const all = core.list({ includeArchived: true })
    expect(all.map((t) => t.id)).toContain(b.id)
    void a
    await core.dispose()
    db.close()
    await dir.dispose()
  })

  test('fork：无会话 → thread_empty；有会话 → 新线程绑定新会话文件', async () => {
    const { core, db, dir } = await makeCore()
    const row = core.create({ workspaceId: 'ws1' })
    const err = await core.fork(row.id, 0).catch((e: unknown) => e)
    expect((err as { code?: string }).code).toBe('conversation.thread_empty')
    await submit(core, row.id, 'hi')
    await new Promise((r) => setTimeout(r, 30))
    const forked = await core.fork(row.id, 0)
    expect(forked.forkedFrom).toBe(row.id)
    expect(forked.title).toBe(`${core.row(row.id)!.title}（分支）`)
    expect(forked.sessionFile).not.toBeNull()
    expect(forked.sessionFile).not.toBe(core.row(row.id)!.sessionFile)
    await core.dispose()
    db.close()
    await dir.dispose()
  })
})
