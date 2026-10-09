import { describe, expect, test } from 'bun:test'
import { createTestLogger } from '@poietica/test-kit'
import type { AutomationDraft } from '../../contract/entities'
import { createRunner } from '../runner'
import { createScheduler } from '../scheduler'
import { createAutomationsService } from '../service'
import { type UnitDeps, unitDeps } from './helpers'

const MINUTE = 60_000

function draftOf(overrides: Partial<AutomationDraft> = {}): AutomationDraft {
  return {
    title: '晨会动态',
    prompt: '汇总进展',
    schedule: { cron: '*/1 * * * *', timeZone: 'UTC' },
    workspaceId: 'ws1',
    posture: 'auto-edit',
    model: null,
    thinking: null,
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
  })
  const scheduler = createScheduler({ repo: d.repo, runner, clock: d.clock, logger })
  const service = createAutomationsService({ repo: d.repo, runner, clock: d.clock, logger })
  return { ...d, logger, runner, scheduler, service, runs }
}

describe('scheduler', () => {
  test('同一任务不并发运行：到期时已有运行中记录，只推进 next_run_at', async () => {
    const { repo, scheduler, service, clock, conversation, db } = build()
    const automation = service.create(draftOf())
    expect(automation.nextRunAt).not.toBeNull()

    /* 第一轮到期：启动一次运行 */
    clock.advance(MINUTE)
    await scheduler.tick()
    expect(repo.runs(automation.id, 10).length).toBe(1)
    expect(conversation.created.length).toBe(1)
    const first = repo.get(automation.id)!
    expect(first.nextRunAt).not.toBeNull()

    /* 第二轮到期：上一个运行还没结束（stub 会话不会自己 settle），不得再启动 */
    clock.advance(MINUTE)
    await scheduler.tick()
    expect(repo.runs(automation.id, 10).length).toBe(1)
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

    /* 模拟上次退出：DB 里留着 running 记录 */
    scheduler.repairOnStartup()
    const runs = repo.runs(automation.id, 10)
    expect(runs[0]!.outcome).toBe('failed')
    expect(runs[0]!.message).toBe('应用退出时仍在运行')
    expect(runs[0]!.settledAt).toBe(clock.now())
    expect(repo.openRun(automation.id)).toBeNull()

    /* 修复之后再到期能正常跑起来 */
    clock.advance(MINUTE)
    await scheduler.tick()
    expect(conversation.created.length).toBe(2)
    db.close()
  })

  test('工作区不可用：运行直接 failed 且任务写 issue', async () => {
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
    expect(repo.get(automation.id)!.issue).toBe('工作区文件夹已不存在')
    db.close()
  })
})
