import { describe, expect, test } from 'bun:test'
import { createTestLogger } from '@poietica/test-kit'
import type { AutomationDraft, AutomationRun } from '../../contract/entities'
import { createRunner, type Runner } from '../runner'
import { createAutomationsService } from '../service'
import { unitDeps } from './helpers'

/*
 * R-06：运行记录的结束不能只绑定在「一轮结束」上 —— 「Core 即时回显」之后提交有独立的
 * 生命周期，`failed` 这个结局不经过任何一轮。这些用例钉住 runner 的两个新入口与轮询的
 * 新边界（idle 不是「运行中」的证据）。
 */

function draftOf(overrides: Partial<AutomationDraft> = {}): AutomationDraft {
  return {
    title: '晨会动态',
    prompt: '汇总进展',
    schedule: { cron: '*/1 * * * *', at: null, timeZone: 'UTC' },
    workspaceId: 'ws1',
    posture: 'auto-edit',
    model: null,
    thinking: null,
    threadMode: 'new',
    threadId: null,
    notify: 'attention',
    catchUp: true,
    ...overrides,
  }
}

function build() {
  const d = unitDeps()
  const logger = createTestLogger()
  const runs: AutomationRun[] = []
  const runner = createRunner({
    repo: d.repo,
    conversation: d.conversation,
    workspaces: d.workspaces,
    clock: d.clock,
    logger,
    emitRunUpdated: (run) => runs.push(run),
    emitAttention: () => undefined,
    emitChanged: () => undefined,
  })
  const service = createAutomationsService({
    repo: d.repo,
    runner,
    conversation: d.conversation,
    clock: d.clock,
    logger,
  })
  return { ...d, logger, runner, service, runs }
}

describe('automations runner（R-06）', () => {
  test('A1 提交未送达：运行收成 failed，任务不再被占用', async () => {
    const { repo, runner, service, runs, db } = build()
    const automation = service.create(draftOf())
    const run = await service.runNow(automation.id)
    const threadId = run.threadId
    if (threadId === null) throw new Error('运行没有关联线程')
    const before = runs.length

    runner.onSubmissionFailed({
      threadId,
      clientTurnId: 'c1',
      deliverAs: 'turn',
      error: { code: 'engine.provider_unavailable', message: '凭据不存在' },
    })

    const settled = repo.getRun(run.id)!
    expect(settled.outcome).toBe('failed')
    expect(settled.message).toContain('凭据不存在')
    expect(settled.settledAt).not.toBeNull()
    expect(runner.isRunning(automation.id)).toBe(false)
    expect(runs.length).toBe(before + 1)
    /* 审查 R-14：运行失败只记在运行记录里，不再挂 issue —— 挂了 issue 的任务 due() 不挑，从此不再被调度 */
    expect(repo.get(automation.id)!.issue).toBeNull()

    /* 收口之后下一次照常能起来（旧代码在这里抛 already_running） */
    const next = await service.runNow(automation.id)
    expect(next.outcome).toBe('running')
    db.close()
  })

  test('A2 失败事件早于 submit 返回：start() 不把结局覆盖回 running', async () => {
    const d = unitDeps()
    const logger = createTestLogger()
    const runs: AutomationRun[] = []
    const submit = d.conversation.submit.bind(d.conversation)
    let runner: Runner | undefined
    d.conversation.submit = async (input) => {
      await submit(input)
      /* 模拟：交接失败的事件在 submit 的 await 返回之前就到了 */
      const open = d.repo.openRunsByThread(input.threadId)[0]
      if (open !== undefined) {
        runner?.onSubmissionFailed({
          threadId: input.threadId,
          clientTurnId: 'c-early',
          deliverAs: 'turn',
          error: { code: 'engine.open_failed', message: '冷打开失败' },
        })
      }
    }
    runner = createRunner({
      repo: d.repo,
      conversation: d.conversation,
      workspaces: d.workspaces,
      clock: d.clock,
      logger,
      emitRunUpdated: (run) => runs.push(run),
      emitAttention: () => undefined,
      emitChanged: () => undefined,
    })
    const service = createAutomationsService({
      repo: d.repo,
      runner,
      conversation: d.conversation,
      clock: d.clock,
      logger,
    })
    const automation = service.create(draftOf())

    const run = await service.runNow(automation.id)

    expect(run.outcome).toBe('failed')
    expect(run.message).toContain('冷打开失败')
    expect(d.repo.getRun(run.id)!.outcome).toBe('failed')
    /* 事件先到、start() 后返回：只发了那一次 failed，没有再补一条 running */
    expect(runs.filter((r) => r.outcome === 'running')).toHaveLength(0)
    d.db.close()
  })

  test('A3 运行中插话失败不算运行失败：followUp 的失败被忽略', async () => {
    const { repo, runner, service, db } = build()
    const automation = service.create(draftOf())
    const run = await service.runNow(automation.id)
    const threadId = run.threadId
    if (threadId === null) throw new Error('运行没有关联线程')

    runner.onSubmissionFailed({
      threadId,
      clientTurnId: 'c2',
      deliverAs: 'followUp',
      error: { code: 'engine.busy', message: '插话没排上' },
    })

    expect(repo.getRun(run.id)!.outcome).toBe('running')
    expect(runner.isRunning(automation.id)).toBe(true)
    db.close()
  })

  test('A4 轮询不再把 idle 当成运行中：awaiting 不被改回 running', async () => {
    const { repo, service, clock, conversation, runs, db } = build()
    const automation = service.create(draftOf())
    const run = await service.runNow(automation.id)
    const threadId = run.threadId
    if (threadId === null) throw new Error('运行没有关联线程')

    conversation.setState(threadId, 'awaiting')
    clock.advance(5_000)
    expect(repo.getRun(run.id)!.outcome).toBe('awaiting')

    /* idle 不是「运行中」的证据：状态留给事件去收，轮询不动它 */
    const before = runs.length
    conversation.setState(threadId, 'idle')
    clock.advance(5_000)
    expect(repo.getRun(run.id)!.outcome).toBe('awaiting')
    expect(runs.length).toBe(before)
    db.close()
  })

  test('A5 对话被删除：运行收成 cancelled，且不在任务卡片上挂 issue', async () => {
    const { repo, runner, service, runs, db } = build()
    const automation = service.create(draftOf())
    const run = await service.runNow(automation.id)
    const threadId = run.threadId
    if (threadId === null) throw new Error('运行没有关联线程')

    runner.onThreadRemoved({ threadId })

    const settled = repo.getRun(run.id)!
    expect(settled.outcome).toBe('cancelled')
    expect(settled.message).toBe('运行所在的对话已被删除')
    expect(settled.settledAt).not.toBeNull()
    expect(runner.isRunning(automation.id)).toBe(false)
    /* 对话没了不是任务的问题 —— 与 fail() 的区别就在这一格 */
    expect(repo.get(automation.id)!.issue).toBeNull()
    expect(runs.at(-1)!.outcome).toBe('cancelled')
    db.close()
  })
})
