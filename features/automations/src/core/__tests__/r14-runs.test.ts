import { describe, expect, test } from 'bun:test'
import { AppError } from '@poietica/foundation'
import type { AutomationRun } from '../../contract/entities'
import { noticeOf } from '../notice'
import {
  APPROVAL_TIMEOUT_MESSAGE,
  BUSY_THREAD_MESSAGE,
  framePrompt,
  REPORT_INSTRUCTION,
  RUN_TIMEOUT_MESSAGE,
} from '../runner'
import { MISSED_MESSAGE } from '../scheduler'
import { buildCore, fullDraft } from './helpers'

/*
 * 审查 R-14：运行与调度。
 *   S1 投给 agent 的那段话；S2–S4 续用对话；S5–S6 两条超时与等批准通知；S7 通知策略；
 *   S8 agent 汇报；S9 一次性任务；S10–S11 错过补跑；S12 失败不再让任务停摆。
 */

const MINUTE = 60_000
const POLL = 5_000

function runOf(over: Partial<AutomationRun>): AutomationRun {
  return {
    id: 'r',
    automationId: 'a',
    threadId: 't',
    trigger: 'schedule',
    scheduledFor: null,
    startedAt: 0,
    settledAt: 1,
    outcome: 'succeeded',
    message: null,
    summary: null,
    attention: false,
    ...over,
  }
}

describe('R-14 运行与调度', () => {
  test('S1 投给 agent 的话：抬头写明任务与触发原因，结尾交代 automation_report', async () => {
    const { service, conversation, db } = buildCore()
    const a = service.create(fullDraft({ title: '晨会动态', prompt: '汇总进展' }))
    await service.runNow(a.id)
    expect(conversation.submitted[0]!.text).toBe(`【定时任务】晨会动态 · 手动运行\n\n汇总进展\n\n${REPORT_INSTRUCTION}`)
    const at = Date.parse('2026-05-02T01:00:00Z')
    expect(
      framePrompt({ ...a, schedule: { cron: '0 9 * * *', at: null, timeZone: 'Asia/Shanghai' } }, 'schedule', at),
    ).toContain('· 计划于 05-02 09:00')
    expect(framePrompt(a, 'catch_up', at)).toContain('· 补跑（原定 05-02 01:00，当时应用没有运行）')
    db.close()
  })

  test('S2 续用：第一次运行新建对话并记下，第二次在同一条对话里跑', async () => {
    const { service, runner, conversation, repo, db, changed } = buildCore()
    const a = service.create(fullDraft({ threadMode: 'continue' }))
    const first = await service.runNow(a.id)
    expect(repo.get(a.id)!.threadId).toBe(first.threadId)
    expect(changed()).toBe(1)
    runner.onTurnSettled({ threadId: first.threadId!, outcome: 'completed', error: null })
    const second = await service.runNow(a.id)
    expect(second.threadId).toBe(first.threadId)
    expect(conversation.created).toHaveLength(1)
    expect(conversation.created[0]!.title).toBe('定时任务：晨会动态')
    db.close()
  })

  test('S3 续用的对话正忙：这一次记 skipped，不往里塞话', async () => {
    const { service, runner, conversation, db } = buildCore()
    const a = service.create(fullDraft({ threadMode: 'continue' }))
    const first = await service.runNow(a.id)
    runner.onTurnSettled({ threadId: first.threadId!, outcome: 'completed', error: null })
    conversation.setState(first.threadId!, 'running')
    const second = await service.runNow(a.id)
    expect(second.outcome).toBe('skipped')
    expect(second.message).toBe(BUSY_THREAD_MESSAGE)
    expect(second.settledAt).not.toBeNull()
    expect(conversation.submitted).toHaveLength(1)
    db.close()
  })

  test('S4 续用的对话被删：任务忘掉它', () => {
    const { service, repo, clock, db } = buildCore()
    const a = service.create(fullDraft({ threadMode: 'continue' }))
    repo.setThread(a.id, 'th-1', clock.now())
    expect(repo.clearThread('th-1', clock.now())).toBe(1)
    expect(repo.get(a.id)!.threadId).toBeNull()
    expect(repo.clearThread('th-1', clock.now())).toBe(0)
    db.close()
  })

  test('S5 运行满 60 分钟：收成 failed 并停会话；之后的 turnSettled 不改写结局', async () => {
    const { service, runner, conversation, repo, clock, attentions, db } = buildCore()
    const a = service.create(fullDraft())
    const run = await service.runNow(a.id)
    conversation.setState(run.threadId!, 'running')
    clock.advance(59 * MINUTE)
    expect(repo.getRun(run.id)!.outcome).toBe('running')
    clock.advance(MINUTE + POLL)
    const settled = repo.getRun(run.id)!
    expect(settled.outcome).toBe('failed')
    expect(settled.message).toBe(RUN_TIMEOUT_MESSAGE)
    expect(conversation.cancelled).toEqual([run.threadId!])
    expect(attentions.at(-1)).toMatchObject({ runId: run.id, title: '「晨会动态」运行失败', body: RUN_TIMEOUT_MESSAGE })
    runner.onTurnSettled({ threadId: run.threadId!, outcome: 'cancelled', error: null })
    expect(repo.getRun(run.id)!.outcome).toBe('failed')
    db.close()
  })

  test('S6 等批准：进入时通知一次；等的时间不算运行时长；等满 2 小时收成 failed', async () => {
    const { service, conversation, repo, clock, attentions, db } = buildCore()
    const a = service.create(fullDraft())
    const run = await service.runNow(a.id)
    conversation.setState(run.threadId!, 'awaiting')
    clock.advance(POLL)
    expect(repo.getRun(run.id)!.outcome).toBe('awaiting')
    expect(attentions.map((x) => x.title)).toEqual(['「晨会动态」等待你批准'])
    clock.advance(90 * MINUTE)
    expect(attentions).toHaveLength(1)
    expect(repo.getRun(run.id)!.outcome).toBe('awaiting')
    clock.advance(30 * MINUTE + POLL)
    expect(repo.getRun(run.id)!.outcome).toBe('failed')
    expect(repo.getRun(run.id)!.message).toBe(APPROVAL_TIMEOUT_MESSAGE)
    expect(conversation.cancelled).toEqual([run.threadId!])
    db.close()
  })

  test('S7 通知策略：never 全不通知；attention 只在失败、等批准、agent 标关注；always 加上每次成功', () => {
    const ok = runOf({})
    const failed = runOf({ outcome: 'failed', message: '凭据不存在' })
    const flagged = runOf({ summary: 'CI 挂了 2 个', attention: true })
    const cancelled = runOf({ outcome: 'cancelled' })
    const at = (notify: 'always' | 'attention' | 'never') => ({ title: '巡检', notify })
    expect(noticeOf(at('never'), failed, 'settled')).toBeNull()
    expect(noticeOf(at('never'), ok, 'awaiting')).toBeNull()
    expect(noticeOf(at('attention'), ok, 'settled')).toBeNull()
    expect(noticeOf(at('attention'), failed, 'settled')).toEqual({ title: '「巡检」运行失败', body: '凭据不存在' })
    expect(noticeOf(at('attention'), flagged, 'settled')).toEqual({ title: '「巡检」需要你关注', body: 'CI 挂了 2 个' })
    expect(noticeOf(at('attention'), ok, 'awaiting')?.title).toBe('「巡检」等待你批准')
    expect(noticeOf(at('always'), runOf({ summary: '一切正常' }), 'settled')).toEqual({
      title: '「巡检」已完成',
      body: '一切正常',
    })
    expect(noticeOf(at('always'), cancelled, 'settled')).toBeNull()
  })

  test('S8 agent 汇报：结论记在开着的运行上，收口时保留；标了关注就通知；没在运行 → not_in_run', async () => {
    const { service, runner, repo, attentions, db } = buildCore()
    const a = service.create(fullDraft())
    const run = await service.runNow(a.id)
    service.report(run.threadId!, 'CI 挂了 2 个', true)
    runner.onTurnSettled({ threadId: run.threadId!, outcome: 'completed', error: null })
    expect(repo.getRun(run.id)).toMatchObject({ outcome: 'succeeded', summary: 'CI 挂了 2 个', attention: true })
    expect(attentions.at(-1)).toMatchObject({
      title: '「晨会动态」需要你关注',
      body: 'CI 挂了 2 个',
      threadId: run.threadId,
    })
    let code: string | null = null
    try {
      service.report(run.threadId!, '再报一次', false)
    } catch (e) {
      code = e instanceof AppError ? e.code : null
    }
    expect(code).toBe('automations.not_in_run')
    db.close()
  })

  test('S9 一次性任务：到点跑一次，然后停用、没有下一次', async () => {
    const { service, scheduler, repo, clock, conversation, db } = buildCore()
    const a = service.create(fullDraft({ schedule: { cron: null, at: clock.now() + MINUTE, timeZone: 'UTC' } }))
    clock.advance(MINUTE)
    await scheduler.tick()
    expect(repo.runs(a.id, 10)).toHaveLength(1)
    expect(repo.get(a.id)).toMatchObject({ enabled: false, nextRunAt: null, issue: null })
    clock.advance(10 * MINUTE)
    await scheduler.tick()
    expect(conversation.created).toHaveLength(1)
    db.close()
  })

  test('S10 错过补跑：启动时发现错过 → 第一次 tick 以 catch_up 跑一次，记着原定时间，然后推到未来', async () => {
    const { service, scheduler, repo, clock, db } = buildCore()
    const a = service.create(fullDraft({ schedule: { cron: '0 9 * * *', at: null, timeZone: 'UTC' } }))
    const missedAt = a.nextRunAt!
    clock.advance(missedAt - clock.now() + 3 * 60 * MINUTE) // 应用「关着」度过了 09:00
    scheduler.repairOnStartup()
    await scheduler.tick()
    const [run] = repo.runs(a.id, 10)
    expect(run).toMatchObject({ trigger: 'catch_up', scheduledFor: missedAt })
    expect(repo.get(a.id)!.nextRunAt).toBeGreaterThan(clock.now())
    db.close()
  })

  test('S11 不补跑：记一条「错过」并推到未来；一次性任务错过且不补跑 → 停用', async () => {
    const { service, scheduler, repo, clock, conversation, db } = buildCore()
    const daily = service.create(
      fullDraft({ schedule: { cron: '0 9 * * *', at: null, timeZone: 'UTC' }, catchUp: false }),
    )
    const once = service.create(
      fullDraft({ schedule: { cron: null, at: clock.now() + MINUTE, timeZone: 'UTC' }, catchUp: false }),
    )
    clock.advance(daily.nextRunAt! - clock.now() + MINUTE)
    scheduler.repairOnStartup()
    expect(repo.runs(daily.id, 10)[0]).toMatchObject({ outcome: 'skipped', message: MISSED_MESSAGE })
    expect(repo.get(daily.id)!.nextRunAt).toBeGreaterThan(clock.now())
    expect(repo.get(once.id)).toMatchObject({ enabled: false, nextRunAt: null })
    await scheduler.tick()
    expect(conversation.created).toHaveLength(0)
    db.close()
  })

  test('S12 一次没送达不再让任务停摆：下一次到点照常运行', async () => {
    const { service, scheduler, runner, repo, clock, conversation, db } = buildCore()
    const a = service.create(fullDraft())
    clock.advance(a.nextRunAt! - clock.now())
    await scheduler.tick()
    const [first] = repo.runs(a.id, 10)
    runner.onSubmissionFailed({
      threadId: first!.threadId!,
      clientTurnId: 'c1',
      deliverAs: 'turn',
      error: { code: 'engine.provider_unavailable', message: '凭据不存在' },
    })
    expect(repo.get(a.id)!.issue).toBeNull()
    clock.advance(MINUTE)
    await scheduler.tick()
    expect(conversation.created).toHaveLength(2)
    db.close()
  })
})
