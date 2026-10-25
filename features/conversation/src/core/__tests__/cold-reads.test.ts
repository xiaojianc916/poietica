import { describe, expect, test } from 'bun:test'
import type { ContextUsage, Controls } from '@poietica/engine'
import { createFakeEngine, type FakeEngine } from '@poietica/engine-testkit'
import { createId, systemClock } from '@poietica/foundation'
import { openDatabase } from '@poietica/storage-sqlite'
import { createTestLogger, tempDir, waitFor } from '@poietica/test-kit'
import { ConversationCore } from '../conversation'
import { migrations } from '../migrations'
import { TimelineHub } from '../timeline-hub'

/*
 * 性能方案 P4：看对话不开会话。时间线的冷读在 P1（timeline-channel 的用例）；这里钉住其余四个读 ——
 * 控件表（快照）、队列、命令表、侧边话题 —— 在会话没开着时都不打开会话，且与活会话那一份对得上；
 * 以及会话打开时 Core 主动把真值推出去、写下快照。
 */

const USAGE: ContextUsage = { usedTokens: 1200, windowTokens: 8000, breakdown: null, session: null }

async function makeCore(options: { readonly contextUsage?: ContextUsage } = {}) {
  const db = openDatabase(':memory:')
  const moduleDb = db.forModule('conversation')
  for (const m of migrations) moduleDb.exec(m.sql)
  const dir = await tempDir('conv-cold-')
  const clock = systemClock
  const engine: FakeEngine = createFakeEngine({
    clock,
    thinkingLevels: ['low', 'high'],
    ...(options.contextUsage === undefined ? {} : { contextUsage: options.contextUsage }),
  })
  engine.freezeTools()
  const controls: { threadId: string; controls: Controls }[] = []
  const commandsChanged: string[] = []
  const states: { threadId: string; state: string }[] = []
  const core = new ConversationCore({
    db: moduleDb,
    engine,
    hub: new TimelineHub({ clock, emitOps: () => undefined, emitReset: () => undefined }),
    workspaces: {
      requireUsable: () => ({ id: 'ws1', path: dir.path, name: 'ws' }),
    } as never,
    attachments: {
      describe: () => [],
      retain: () => undefined,
      releaseOwner: () => undefined,
      resolve: () => [],
      copyOwner: () => undefined,
    } as never,
    clock,
    logger: createTestLogger(),
    emitThreadUpdated: () => undefined,
    emitThreadRemoved: () => undefined,
    emitTurnState: (s) => {
      states.push({ threadId: s.threadId, state: s.state })
    },
    emitTurnDropped: () => undefined,
    emitQueue: () => undefined,
    emitControls: (p) => {
      controls.push(p)
    },
    emitCommandOutput: () => undefined,
    emitCommandsChanged: (p) => {
      commandsChanged.push(p.threadId)
    },
    emitSideTopic: () => undefined,
    emitSideDelta: () => undefined,
    emitSideNotice: () => undefined,
    emitFileChanged: () => undefined,
    emitContextUsage: () => undefined,
    emitInteractionRequested: () => undefined,
    emitInteractionResolved: () => undefined,
    emitSubmissionChanged: () => undefined,
    emitSubmissionRemoved: () => undefined,
    emitTurnSettled: () => undefined,
    emitSubmissionFailed: () => undefined,
    emitThreadRemovedEvent: () => undefined,
    emitUsageSampled: () => undefined,
    emitUserMessage: () => undefined,
  })
  const snapshotText = (threadId: string): string | null =>
    moduleDb
      .prepare<{ controls_snapshot: string | null }>('SELECT controls_snapshot FROM conversation_threads WHERE id = ?')
      .get(threadId)?.controls_snapshot ?? null
  const writeSnapshot = (threadId: string, text: string | null): void => {
    moduleDb.prepare('UPDATE conversation_threads SET controls_snapshot = ? WHERE id = ?').run(text, threadId)
  }
  /** 说一句并等它跑完（替身按真时钟一拍一拍地推） */
  const turn = async (threadId: string, text: string): Promise<void> => {
    const settledBefore = states.filter((s) => s.threadId === threadId && s.state === 'idle').length
    await core.turns.submit({
      threadId,
      clientTurnId: createId(),
      text,
      attachmentIds: [],
      skills: [],
      deliverAs: 'turn',
    })
    await waitFor(() => states.filter((s) => s.threadId === threadId && s.state === 'idle').length > settledBefore)
  }
  const finish = async (): Promise<void> => {
    await core.dispose()
    db.close()
    await dir.dispose()
  }
  return { core, engine, controls, commandsChanged, snapshotText, writeSnapshot, turn, finish }
}

describe('看对话不开会话（性能方案 P4）', () => {
  test('还没落过盘的线程：四个读都不开会话；控件表是按行上初始三格的草稿表', async () => {
    const t = await makeCore()
    const row = t.core.threads.create({
      workspaceId: 'ws1',
      model: { provider: 'fake', id: 'second' },
      thinking: 'low',
      posture: 'full-access',
    })

    const controls = await t.core.turns.controls(row.id)
    expect(controls.model.current).toEqual({ provider: 'fake', id: 'second' })
    expect(controls.thinking.current).toBe('low')
    expect(controls.posture).toBe('full-access')
    expect(await t.core.turns.queue(row.id)).toEqual({ items: [], modes: { steer: 'all', followUp: 'all' } })
    /* 入口页同一张表：只对已有对话有意义的命令不列 */
    expect((await t.core.turns.commands(row.id)).map((c) => c.name)).not.toContain('compact')
    expect(await t.core.turns.sideTopics(row.id)).toEqual([])
    expect(t.engine.opened).toHaveLength(0)
    await t.finish()
  })

  test('落过盘的线程关掉以后：控件表照快照冷读、与活会话那份对得上；队列、命令、话题都不开会话', async () => {
    const t = await makeCore()
    const row = t.core.threads.create({ workspaceId: 'ws1', posture: 'ask' })
    await t.turn(row.id, '第一句')
    await t.core.turns.setModel(row.id, { provider: 'fake', id: 'second' })
    await t.core.turns.setThinking(row.id, 'high')
    const topic = await t.core.turns.askSide(row.id, '旁边问一句', null)
    await waitFor(async () => (await t.core.turns.sideTopics(row.id))[0]?.turns[0]?.status === 'complete')
    const live = await t.core.turns.controls(row.id)
    const liveTopics = await t.core.turns.sideTopics(row.id)
    await t.core.turns.close(row.id)
    expect(t.core.turns.peek(row.id)).toBeUndefined()
    const opened = t.engine.opened.length

    const cold = await t.core.turns.controls(row.id)
    expect(cold.model.current).toEqual({ provider: 'fake', id: 'second' })
    expect(cold.model.current).toEqual(live.model.current)
    expect(cold.model.choices.map((c) => c.ref)).toContainEqual({ provider: 'fake', id: 'second' })
    expect(cold.thinking).toEqual(live.thinking)
    expect(cold.posture).toBe(live.posture)
    expect(cold.planMode).toBe(live.planMode)
    expect(cold.goal).toBe(live.goal)
    expect(await t.core.turns.queue(row.id)).toEqual({ items: [], modes: { steer: 'all', followUp: 'all' } })
    /* 落过盘：压缩、重试这类只对已有对话有意义的命令也在 */
    expect((await t.core.turns.commands(row.id)).map((c) => c.name)).toContain('compact')
    const coldTopics = await t.core.turns.sideTopics(row.id)
    expect(coldTopics.map((x) => x.id)).toEqual([topic.id])
    expect(coldTopics).toEqual(liveTopics)
    expect(t.engine.opened).toHaveLength(opened)
    await t.finish()
  })

  test('会话打开时主动推一次控件表与命令表变化，并写下快照', async () => {
    const t = await makeCore()
    const row = t.core.threads.create({ workspaceId: 'ws1' })
    expect(t.snapshotText(row.id)).toBeNull()

    await t.core.turns.open(row.id)
    expect(t.controls.filter((p) => p.threadId === row.id)).toHaveLength(1)
    expect(t.commandsChanged).toEqual([row.id])
    expect(t.snapshotText(row.id)).not.toBeNull()
    await t.finish()
  })

  test('上下文用量跟进快照：关掉以后冷读的控件表带着最后一次报数', async () => {
    const t = await makeCore({ contextUsage: USAGE })
    const row = t.core.threads.create({ workspaceId: 'ws1' })
    await t.turn(row.id, '算一下用量')
    await t.core.turns.close(row.id)

    expect((await t.core.turns.controls(row.id)).context).toEqual(USAGE)
    await t.finish()
  })

  test('落过盘却没有快照（快照写入之前的老行）：第一次照旧打开会话现问，此后冷读；读不懂的快照按没有处置', async () => {
    const t = await makeCore()
    const row = t.core.threads.create({ workspaceId: 'ws1' })
    await t.turn(row.id, '先说过一句')
    await t.core.turns.close(row.id)
    t.writeSnapshot(row.id, null)
    const opened = t.engine.opened.length

    await t.core.turns.controls(row.id)
    expect(t.engine.opened).toHaveLength(opened + 1)
    expect(t.snapshotText(row.id)).not.toBeNull()
    await t.core.turns.close(row.id)
    await t.core.turns.controls(row.id)
    expect(t.engine.opened).toHaveLength(opened + 1)

    await t.core.turns.close(row.id)
    t.writeSnapshot(row.id, '{"model":')
    await t.core.turns.controls(row.id)
    expect(t.engine.opened).toHaveLength(opened + 2)
    await t.finish()
  })

  test('快照里的模型不在此刻的候选里（下架、白名单外）：照原样补在候选最前，不替用户换一条', async () => {
    const t = await makeCore()
    const row = t.core.threads.create({ workspaceId: 'ws1' })
    await t.turn(row.id, '用旧模型说的')
    await t.core.turns.close(row.id)
    const gone = { provider: 'gone', id: 'old-model' }
    const held = JSON.parse(t.snapshotText(row.id)!) as Record<string, unknown>
    t.writeSnapshot(
      row.id,
      JSON.stringify({
        ...held,
        model: gone,
        choice: { ref: gone, label: 'Old Model', reasoning: false, images: false },
      }),
    )

    const cold = await t.core.turns.controls(row.id)
    expect(cold.model.current).toEqual(gone)
    expect(cold.model.choices[0]).toEqual({ ref: gone, label: 'Old Model', reasoning: false, images: false })
    await t.finish()
  })
})
