import { describe, expect, test } from 'bun:test'
import { AppError } from '@poietica/foundation'
import { createTestLogger } from '@poietica/test-kit'
import type { AutomationDraft } from '../../contract/entities'
import { AUTOMATION_CREATE_LIMIT, CLAIM_STALE_MS, DISPATCH_RETRY_BASE_MS } from '../repository'
import { createRunner } from '../runner'
import { createScheduler, LATE_GRACE_MS } from '../scheduler'
import { createAutomationsService } from '../service'
import { type UnitDeps, unitDeps } from './helpers'

const MINUTE = 60_000

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

function build(overrides: { readonly workspaces?: UnitDeps['workspaces'] } = {}) {
  const d = unitDeps(overrides)
  const workspaces = d.workspaces
  const logger = createTestLogger()
  const runs: string[] = []
  const runner = createRunner({
    repo: d.repo,
    conversation: d.conversation,
    workspaces,
    clock: d.clock,
    logger,
    emitRunUpdated: (run) => runs.push(run.id),
    emitAttention: () => undefined,
    emitChanged: () => undefined,
  })
  const scheduler = createScheduler({ repo: d.repo, runner, clock: d.clock, logger })
  const service = createAutomationsService({
    repo: d.repo,
    runner,
    conversation: d.conversation,
    clock: d.clock,
    logger,
  })
  return { ...d, logger, runner, scheduler, service, runs }
}

describe('scheduler', () => {
  test('同一任务不并发运行：到期时已有运行中记录，记一条 skipped 并推进 next_run_at（审查 R-14）', async () => {
    const { repo, scheduler, service, clock, conversation, db } = build()
    const automation = service.create(draftOf())
    expect(automation.nextRunAt).not.toBeNull()

    clock.advance(MINUTE)
    await scheduler.tick()
    expect(repo.runs(automation.id, 10).length).toBe(1)
    expect(conversation.created.length).toBe(1)
    const first = repo.get(automation.id)!
    expect(first.nextRunAt).not.toBeNull()

    /* 上一个运行还没结束（stub 会话不会自己 settle）：不得再启动，但要留一条「跳过」。 */
    clock.advance(MINUTE)
    await scheduler.tick()
    const runs = repo.runs(automation.id, 10)
    expect(runs.length).toBe(2)
    expect(runs[0]!.outcome).toBe('skipped')
    expect(runs[0]!.message).toBe('上一次运行还没结束，跳过这一次')
    expect(conversation.created.length).toBe(1)
    const second = repo.get(automation.id)!
    expect(second.nextRunAt).not.toBe(first.nextRunAt)
    db.close()
  })

  test('有 issue 的任务不调度，修好后重新进入调度', async () => {
    const { repo, scheduler, service, clock, conversation, db } = build()
    const automation = service.create(draftOf())
    repo.setIssue(automation.id, '工作区已不存在', clock.now())
    clock.advance(MINUTE)
    await scheduler.tick()
    expect(conversation.created.length).toBe(0)
    expect(repo.runs(automation.id, 10).length).toBe(0)

    repo.setIssue(automation.id, null, clock.now())
    clock.advance(MINUTE)
    await scheduler.tick()
    expect(conversation.created.length).toBe(1)
    db.close()
  })

  test('启动修复：running/awaiting → failed（message 正确），并重算 next_run_at 与 issue', async () => {
    const { repo, scheduler, service, clock, conversation, db } = build()
    const automation = service.create(draftOf())
    await service.runNow(automation.id)
    expect(repo.openRun(automation.id)).not.toBeNull()

    scheduler.repairOnStartup()
    const runs = repo.runs(automation.id, 10)
    expect(runs[0]!.outcome).toBe('failed')
    expect(runs[0]!.message).toBe('应用退出时仍在运行')
    expect(runs[0]!.settledAt).toBe(clock.now())
    expect(repo.openRun(automation.id)).toBeNull()

    clock.advance(MINUTE)
    await scheduler.tick()
    expect(conversation.created.length).toBe(2)
    db.close()
  })

  test('工作区不可用：运行直接 failed，任务不挂 issue（下一次到点照常再试，审查 R-14）', async () => {
    const { repo, service, db, runs } = build({
      workspaces: {
        get: () => null,
        requireUsable() {
          throw new Error('工作区文件夹已不存在')
        },
        list: () => [],
      },
    })
    const automation = service.create(draftOf())
    const run = await service.runNow(automation.id)
    expect(run.outcome).toBe('failed')
    expect(run.message).toBe('工作区文件夹已不存在')
    expect(run.settledAt).not.toBeNull()
    expect(runs).toContain(run.id)
    expect(repo.get(automation.id)!.issue).toBeNull()
    db.close()
  })

  test('认领是原子单飞：同一时刻第二次拿不到；超过 10 分钟才回收', () => {
    const { repo, service, clock, db } = build()
    const automation = service.create(draftOf())
    clock.advance(MINUTE)
    expect(repo.claimDue(clock.now()).map((row) => row.id)).toEqual([automation.id])
    expect(repo.claimDue(clock.now())).toEqual([])

    clock.advance(CLAIM_STALE_MS - 1)
    expect(repo.claimDue(clock.now())).toEqual([])
    clock.advance(2)
    expect(repo.claimDue(clock.now()).map((row) => row.id)).toEqual([automation.id])
    db.close()
  })

  test('一次性任务错过窗口：即使 catchUp 也直接停用，不补跑', async () => {
    const { service, scheduler, clock, conversation, repo, db } = build()
    const at = clock.now() + MINUTE
    const automation = service.create(draftOf({ schedule: { cron: null, at, timeZone: 'UTC' }, catchUp: true }))

    clock.advance(MINUTE + LATE_GRACE_MS + 1)
    await scheduler.tick()
    expect(conversation.created.length).toBe(0)
    const after = repo.get(automation.id)!
    expect(after.enabled).toBe(false)
    expect(after.nextRunAt).toBeNull()
    expect(repo.runs(automation.id, 10)[0]!.outcome).toBe('skipped')
    db.close()
  })

  test('派发瞬时失败：退避期内不重试，到期后沿用同一条运行与同一条对话重试', async () => {
    const base = unitDeps()
    let failures = 1
    const flaky = {
      ...base.conversation,
      async submit(input: Parameters<typeof base.conversation.submit>[0]) {
        if (failures > 0) {
          failures -= 1
          throw new Error('引擎忙')
        }
        return base.conversation.submit(input)
      },
    }
    const logger = createTestLogger()
    const runner = createRunner({
      repo: base.repo,
      conversation: flaky,
      workspaces: base.workspaces,
      clock: base.clock,
      logger,
      emitRunUpdated: () => undefined,
      emitAttention: () => undefined,
      emitChanged: () => undefined,
    })
    const scheduler = createScheduler({ repo: base.repo, runner, clock: base.clock, logger })
    const service = createAutomationsService({
      repo: base.repo,
      runner,
      conversation: flaky,
      clock: base.clock,
      logger,
    })
    const automation = service.create(draftOf())

    base.clock.advance(MINUTE)
    await scheduler.tick()
    const first = base.repo.runs(automation.id, 10)
    expect(first.length).toBe(1)
    expect(first[0]!.outcome).toBe('failed')
    expect(first[0]!.dispatchStatus).toBe('failed_to_dispatch')
    expect(base.repo.get(automation.id)!.retryAt).toBe(base.clock.now() + DISPATCH_RETRY_BASE_MS)

    base.clock.advance(DISPATCH_RETRY_BASE_MS - 1)
    await scheduler.tick()
    expect(base.repo.runs(automation.id, 10).length).toBe(1)

    base.clock.advance(1)
    await scheduler.tick()
    const runs = base.repo.runs(automation.id, 10)
    expect(runs.length).toBe(1)
    expect(runs[0]!.outcome).toBe('running')
    expect(runs[0]!.dispatchStatus).toBe('dispatched')
    expect(runs[0]!.attempts).toBe(2)
    expect(base.conversation.created.length).toBe(1)
    base.db.close()
  })

  test('创建上限：全库 20 条，第 21 条被拒', () => {
    const { service, db } = build()
    for (let i = 0; i < AUTOMATION_CREATE_LIMIT; i++) {
      service.create(draftOf({ title: `任务 ${i}` }))
    }
    let code: string | null = null
    try {
      service.create(draftOf({ title: '第 21 条' }))
    } catch (e) {
      code = e instanceof AppError ? e.code : String(e)
    }
    expect(code).toBe('automations.create_limit')
    db.close()
  })

  test('次数上限：派发一次后停用，不再排下一次', async () => {
    const { service, scheduler, clock, conversation, repo, db } = build()
    const automation = service.create(draftOf({ maxRuns: 1 }))
    clock.advance(MINUTE)
    await scheduler.tick()
    expect(conversation.created.length).toBe(1)
    const after = repo.get(automation.id)!
    expect(after.runCount).toBe(1)
    expect(after.enabled).toBe(false)
    expect(after.nextRunAt).toBeNull()

    clock.advance(MINUTE)
    await scheduler.tick()
    expect(conversation.created.length).toBe(1)
    db.close()
  })

  test('截止时刻：下一次超过截止就停用；已过截止在认领前直接停用', async () => {
    const { service, scheduler, clock, conversation, repo, db } = build()
    const first = service.create(draftOf({ endAt: clock.now() + MINUTE + 30_000 }))
    clock.advance(MINUTE)
    await scheduler.tick()
    expect(conversation.created.length).toBe(1)
    expect(repo.get(first.id)!.enabled).toBe(false)
    expect(repo.get(first.id)!.nextRunAt).toBeNull()

    const second = service.create(draftOf({ title: '第二条', endAt: clock.now() + 5 * MINUTE }))
    clock.advance(10 * MINUTE)
    await scheduler.tick()
    expect(repo.get(second.id)!.enabled).toBe(false)
    expect(conversation.created.length).toBe(1)
    db.close()
  })
})
