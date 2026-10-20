import { describe, expect, test } from 'bun:test'
import { createFakeEngine } from '@poietica/engine-testkit'
import { systemClock } from '@poietica/foundation'
import { openDatabase } from '@poietica/storage-sqlite'
import { createTestLogger, tempDir } from '@poietica/test-kit'
import { conversationContract } from '../../contract'
import { ConversationCore } from '../conversation'
import { migrations } from '../migrations'
import { TimelineHub } from '../timeline-hub'
import { harness } from './helpers'

/*
 * 自动总结标题的接线（omp 知识 #17）：omp 的首句兜底 → 总结成功替换 → 失败保留兜底。
 *
 * 走真实内核（conversation 模块 + FakeEngine），因为这条链要跨三处：提交服务写兜底、
 * 事件路由转发 sessionTitle、线程服务写回。FakeEngine 的 autoTitle 替身按**端口的语义**
 * 发事件（生成失败就什么都不发），所以这里测的是接线而不是替身。
 */
async function started(autoTitle?: (text: string) => string | null | undefined) {
  const { h, engine } = await harness(autoTitle === undefined ? {} : { autoTitle })
  const api = h.client(conversationContract)
  const workspaces = h.client((await import('@poietica/feature-workspaces/contract')).workspacesContract)
  const { tempDir } = await import('@poietica/test-kit')
  const dir = await tempDir('conv-title-')
  const ws = await workspaces.call('workspaces.add', { path: dir.path })
  const thread = await api.call('threads.create', { workspaceId: ws.id })
  const submit = (clientTurnId: string, text: string) =>
    api.call('turns.submit', {
      threadId: thread.id,
      clientTurnId,
      text,
      attachmentIds: [],
      skills: [],
      deliverAs: 'turn',
    })
  return {
    h,
    api,
    engine,
    thread,
    submit,
    finish: async () => {
      await h.dispose()
      await dir.dispose()
    },
  }
}

/** 推过 FakeEngine 的下一拍与时间线合批窗口 */
const beat = async (h: Awaited<ReturnType<typeof harness>>['h']): Promise<void> => {
  await h.clock.advanceAsync(1)
  await h.clock.advanceAsync(20)
}

describe('自动总结标题的接线（omp 知识 #17）', () => {
  test('T1 总结成功：先写首句兜底，随后被 omp 的标题替换', async () => {
    const { api, thread, submit, finish, h } = await started((text) => `总结：${text.slice(0, 4)}`)
    await submit('C1', '帮我修一下登录页的样式问题')
    /*
     * 兜底先落：提交存下时就写了首句（turns.submit 的那一句 autoTitle）。
     * 断言的是**提交返回值那一刻**的行：omp 的总结在替身里是同步的（真引擎要一次网络往返），
     * 所以这里不等下一拍，直接看兜底。
     */
    const immediate = await api.call('threads.get', { threadId: thread.id })
    expect(immediate.titleSource).not.toBe('pending')

    await beat(h)
    const after = await api.call('threads.get', { threadId: thread.id })
    expect(after.title).toBe('总结：帮我修一')
    /* 仍是 auto：omp 总结出来的名字不是「用户定名」，标题栏的样式与可编辑性都不变 */
    expect(after.titleSource).toBe('auto')

    /* 再验一次「新会话的第一句」这条路：没有兜底就没有可回退的标题 */
    const fresh = await api.call('threads.create', { workspaceId: thread.workspaceId })
    expect(fresh.titleSource).toBe('pending')
    await finish()
  })

  test('T2 总结失败（不发事件）：标题留在首句兜底上', async () => {
    const { api, thread, submit, finish, h } = await started(() => null)
    await submit('C2', '帮我修一下登录页的样式问题')
    await beat(h)
    const after = await api.call('threads.get', { threadId: thread.id })
    expect(after.title).toBe('帮我修一下登录页的样式问题')
    expect(after.titleSource).toBe('auto')
    await finish()
  })

  test('T3 用户改过名（user）：omp 的总结标题不许覆盖它', async () => {
    const { api, thread, submit, finish, h } = await started(() => 'omp 起的名字')
    await api.call('threads.rename', { threadId: thread.id, title: '我自己起的' })
    await submit('C3', '再问一句别的')
    await beat(h)
    const after = await api.call('threads.get', { threadId: thread.id })
    expect(after.title).toBe('我自己起的')
    expect(after.titleSource).toBe('user')
    await finish()
  })

  test('T3b 改名不是活动：updatedAt 原样不动', async () => {
    const { api, thread, finish, h } = await started()
    const before = await api.call('threads.get', { threadId: thread.id })
    /* 时钟走一段，确认 rename 之后读到的仍是旧时刻，而不是「现在」。 */
    await h.clock.advanceAsync(60_000)
    const renamed = await api.call('threads.rename', { threadId: thread.id, title: '只改名字' })
    expect(renamed.updatedAt).toBe(before.updatedAt)
    const after = await api.call('threads.get', { threadId: thread.id })
    expect(after.updatedAt).toBe(before.updatedAt)
    expect(after.titleSource).toBe('user')
    await finish()
  })

  test('T4 已定名的线程（自动化建的那种）不再触发 omp 总结', async () => {
    const seen: string[] = []
    const { h, api, thread, submit, finish, engine } = await started((text) => {
      seen.push(text)
      return 'omp 起的名字'
    })
    /* 有名字的线程：describe 会把 autoTitle 关掉，omp 侧一次都不该被调用 */
    await api.call('threads.rename', { threadId: thread.id, title: '定时任务：每日巡检 10-11 08:00' })
    await submit('C4', '跑一遍巡检')
    await beat(h)
    expect(seen).toEqual([])
    const spec = engine.opened[0]
    expect(spec?.autoTitle).toBe(false)
    await finish()
  })
})

test('T5 守卫：旧会话的迟到事件不许改现在的标题（sessionFile 不匹配）', async () => {
  /*
   * 直构 ConversationCore：这条用例要投一条「来自别的会话文件」的事件，而那是会话池
   * 之外的入口（真实形状是线程被驱逐重开后旧会话迟到）。
   */
  const db = openDatabase(':memory:')
  for (const m of migrations) db.forModule('conversation').exec(m.sql!)
  const dir = await tempDir('conv-title-guard-')
  const clock = systemClock
  const hub = new TimelineHub({ clock, emitOps: () => undefined, emitReset: () => undefined })
  const core = new ConversationCore({
    db: db.forModule('conversation'),
    engine: createFakeEngine({ clock }),
    hub,
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
    emitTurnState: () => undefined,
    emitTurnDropped: () => undefined,
    emitQueue: () => undefined,
    emitControls: () => undefined,
    emitCommandOutput: () => undefined,
    emitCommandsChanged: () => undefined,
    emitSideTopic: () => undefined,
    emitSideDelta: () => undefined,
    emitSideNotice: () => undefined,
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
  const row = core.threads.create({ workspaceId: 'ws1' })
  /* 行上先落一份它自己的会话文件（守卫就是拿它比对迟到的 sessionFile） */
  core.threads.onOpened(row.id, {
    sessionId: 's1',
    sessionFile: 'own.jsonl',
  } as never)
  core.threads.autoTitle(row.id, '第一句')

  /* ① 本会话的名（sessionFile 对得上）→ 替换首句兜底 */
  core.onEvent(row.id, { type: 'sessionTitle', title: '总结出来的名字', source: 'auto', sessionFile: 'own.jsonl' })
  expect(core.threads.row(row.id)?.title).toBe('总结出来的名字')

  /* ② 旧会话迟到的名（sessionFile 对不上）→ 不改 */
  core.onEvent(row.id, {
    type: 'sessionTitle',
    title: '旧会话的名字',
    source: 'auto',
    sessionFile: 'someone-else.jsonl',
  })
  expect(core.threads.row(row.id)?.title).toBe('总结出来的名字')

  /* ③ omp 报回用户定名（`/rename` 命令或 GUI 改名的回声）→ 照抄，来源记 user */
  core.onEvent(row.id, { type: 'sessionTitle', title: '我自己起的', source: 'user', sessionFile: 'own.jsonl' })
  expect(core.threads.row(row.id)?.title).toBe('我自己起的')
  expect(core.threads.row(row.id)?.titleSource).toBe('user')

  /* ④ 定过名之后，自动总结的名不许覆盖；再一次用户定名照样生效 */
  core.onEvent(row.id, { type: 'sessionTitle', title: 'omp 又想改', source: 'auto', sessionFile: 'own.jsonl' })
  expect(core.threads.row(row.id)?.title).toBe('我自己起的')
  core.onEvent(row.id, { type: 'sessionTitle', title: '又改了一次', source: 'user', sessionFile: 'own.jsonl' })
  expect(core.threads.row(row.id)?.title).toBe('又改了一次')

  await core.dispose()
  db.close()
  await dir.dispose()
})

describe('会话名以 omp 为唯一产地（P4）', () => {
  test('N1 改名先写进引擎的会话，再改线程行；分叉的名字也写进新会话', async () => {
    const { api, thread, submit, finish, h, engine } = await started()
    await submit('C1', '第一句')
    await beat(h)
    await beat(h)
    const renamed = await api.call('threads.rename', { threadId: thread.id, title: '  我起的名字  ' })
    expect(renamed.title).toBe('我起的名字')
    expect([...engine.sessionNames.values()]).toEqual(['我起的名字'])

    const forked = await api.call('threads.fork', { threadId: thread.id })
    expect(forked.title).toBe('我起的名字（分支）')
    expect([...engine.sessionNames.values()]).toContain('我起的名字（分支）')
    await finish()
  })
})
