import { describe, expect, test } from 'bun:test'
import { createTestLogger } from '@poietica/test-kit'
import type { AutomationDraft } from '../../contract/entities'
import { createRunner } from '../runner'
import { createAutomationsService } from '../service'
import { unitDeps } from './helpers'

function draftOf(overrides: Partial<AutomationDraft> = {}): AutomationDraft {
  return {
    title: '风险扫描',
    prompt: '检查最近 24 小时',
    schedule: { cron: '0 10 * * *', timeZone: 'Asia/Shanghai' },
    workspaceId: 'ws1',
    posture: 'auto-edit',
    model: null,
    thinking: null,
    ...overrides,
  }
}

function build() {
  const d = unitDeps()
  const logger = createTestLogger()
  const runner = createRunner({
    repo: d.repo,
    conversation: d.conversation,
    workspaces: d.workspaces,
    clock: d.clock,
    logger,
    emitRunUpdated: () => undefined,
  })
  return { ...d, service: createAutomationsService({ repo: d.repo, runner, clock: d.clock, logger }), runner }
}

describe('automations service', () => {
  test('创建算出下一次运行；cron 为 null 是只手动运行', () => {
    const { service, db } = build()
    const scheduled = service.create(draftOf())
    expect(scheduled.nextRunAt).not.toBeNull()
    expect(scheduled.issue).toBeNull()
    expect(scheduled.enabled).toBe(true)

    const manual = service.create(draftOf({ schedule: { cron: null, timeZone: 'UTC' } }))
    expect(manual.nextRunAt).toBeNull()
    expect(manual.issue).toBeNull()
    db.close()
  })

  test('读不懂的计划被拒（invalid_schedule）', () => {
    const { service, db } = build()
    const err = (() => {
      try {
        service.create(draftOf({ schedule: { cron: '0 0 * *', timeZone: 'UTC' } }))
        return null
      } catch (e) {
        return e as { code?: string }
      }
    })()
    expect(err?.code).toBe('automations.invalid_schedule')
    db.close()
  })

  test('runNow：已有运行中的记录 → already_running', async () => {
    const { service, db } = build()
    const automation = service.create(draftOf())
    await service.runNow(automation.id)
    const err = await service.runNow(automation.id).catch((e: unknown) => e)
    expect((err as { code?: string }).code).toBe('automations.already_running')
    db.close()
  })

  test('历史只保留最近 50 条运行记录', async () => {
    const { service, repo, db } = build()
    const automation = service.create(draftOf())
    for (let i = 0; i < 55; i++) {
      const run = await service.runNow(automation.id)
      /* 让每次运行落定，下一轮才能再启动 */
      repo.updateRun({ ...run, outcome: 'succeeded', settledAt: i })
    }
    expect(repo.runs(automation.id, 100).length).toBe(50)
    db.close()
  })

  test('删除任务：先取消运行中的记录，运行历史随之级联删除', async () => {
    const { service, repo, conversation, db } = build()
    const automation = service.create(draftOf())
    const run = await service.runNow(automation.id)
    await service.remove(automation.id)
    const threadId = run.threadId
    if (threadId === null) {
      throw new Error('运行记录没有关联线程')
    }
    expect(conversation.cancelled).toEqual([threadId])
    expect(repo.get(automation.id)).toBeNull()
    expect(repo.runs(automation.id, 10).length).toBe(0)
    db.close()
  })

  test('turnSettled 映射：completed → succeeded，cancelled → cancelled，failed 带 message', async () => {
    const { service, repo, runner, db } = build()
    const a = service.create(draftOf())
    const first = await service.runNow(a.id)
    runner.onTurnSettled({ threadId: first.threadId!, outcome: 'completed', error: null })
    expect(repo.getRun(first.id)!.outcome).toBe('succeeded')
    expect(repo.getRun(first.id)!.settledAt).not.toBeNull()

    const second = await service.runNow(a.id)
    runner.onTurnSettled({ threadId: second.threadId!, outcome: 'cancelled', error: null })
    expect(repo.getRun(second.id)!.outcome).toBe('cancelled')

    const third = await service.runNow(a.id)
    runner.onTurnSettled({
      threadId: third.threadId!,
      outcome: 'failed',
      error: { code: 'engine.upstream_error', message: '上游炸了' },
    })
    expect(repo.getRun(third.id)!.outcome).toBe('failed')
    expect(repo.getRun(third.id)!.message).toBe('上游炸了')
    db.close()
  })

  test('预览返回未来若干次与问题', () => {
    const { service, db } = build()
    const result = service.previewSchedule({ cron: '0 9 * * *', timeZone: 'Asia/Shanghai' }, 5)
    expect(result.times.length).toBe(5)
    expect(result.problem).toBeNull()
    const bad = service.previewSchedule({ cron: '0 0 * *', timeZone: 'Asia/Shanghai' }, 5)
    expect(bad.problem).toBe('unreadable')
    expect(bad.times).toEqual([])
    db.close()
  })
})
