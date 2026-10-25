import { describe, expect, test } from 'bun:test'
import { AppError } from '@poietica/foundation'
import { AutomationDraft, AutomationPatch } from '../../contract/entities'
import { buildCore, createTestDatabase, fullDraft, stubWorkspaces, testWorkspace } from './helpers'

/* R-14：D1 patch 不带默认值；D2 当前 schema 的新列写进去就是读出来的那份；D3–D5 一次性计划的校验；D6–D8 续用对话的规矩。 */

const HOUR = 3_600_000

function codeOf(fn: () => unknown): string | null {
  try {
    fn()
    return null
  } catch (e) {
    return e instanceof AppError ? e.code : String(e)
  }
}

describe('R-14 契约与数据模型', () => {
  test('D1 patch 表不带默认值：只给标题就只有标题（旧的 AutomationDraft.partial() 会补出 posture/model/thinking）', () => {
    expect(AutomationPatch.parse({ title: '改个名' })).toEqual({ title: '改个名' })
    /* 对照：旧写法确实会补默认值 —— 这就是 bug 的来源。 */
    expect(AutomationDraft.partial().parse({ title: '改个名' })).toMatchObject({ posture: 'auto-edit', model: null })
  })

  test('D2 当前 schema：任务与运行记录的新列写进去就是读出来的那份', () => {
    const { db, repo } = createTestDatabase()
    const created = repo.create(
      'a1',
      fullDraft({
        schedule: { cron: null, at: 1, timeZone: 'UTC' },
        threadMode: 'continue',
        notify: 'never',
        catchUp: false,
      }),
      0,
    )
    /* 计划二选一、续用模式、不提醒、不补跑：四格各自落到自己的列上 */
    expect(created.schedule).toEqual({ cron: null, at: 1, timeZone: 'UTC' })
    expect([created.threadMode, created.notify, created.catchUp]).toEqual(['continue', 'never', false])

    /* 补跑与手动之外的第三种触发，结局多一档 skipped；summary / attention 是跑完后的两份结论 */
    repo.insertRun({
      id: 'r1',
      automationId: 'a1',
      threadId: null,
      trigger: 'catch_up',
      scheduledFor: null,
      startedAt: 5,
      settledAt: 6,
      outcome: 'skipped',
      message: null,
      summary: '这一次不必跑',
      attention: true,
    })
    expect(repo.getRun('r1')).toMatchObject({
      trigger: 'catch_up',
      outcome: 'skipped',
      summary: '这一次不必跑',
      attention: true,
    })
    db.close()
  })

  test('D3 一次性计划：nextRunAt 就是那个时刻；时间已过 / 与 cron 同时给 → invalid_schedule', () => {
    const { service, clock, db } = buildCore()
    const at = clock.now() + 2 * HOUR
    const once = service.create(fullDraft({ schedule: { cron: null, at, timeZone: 'UTC' } }))
    expect(once.nextRunAt).toBe(at)
    expect(once.issue).toBeNull()
    expect(service.previewSchedule(once.schedule, 5).times).toEqual([at])
    expect(
      codeOf(() => service.create(fullDraft({ schedule: { cron: null, at: clock.now() - 1, timeZone: 'UTC' } }))),
    ).toBe('automations.invalid_schedule')
    expect(codeOf(() => service.create(fullDraft({ schedule: { cron: '0 9 * * *', at, timeZone: 'UTC' } })))).toBe(
      'automations.invalid_schedule',
    )
    db.close()
  })

  test('D4 跑完的一次性任务（时间已过）：改标题照常；重新启用 → invalid_schedule；时间已过不算 issue', () => {
    const { service, clock, db } = buildCore()
    const at = clock.now() + HOUR
    const once = service.create(fullDraft({ schedule: { cron: null, at, timeZone: 'UTC' } }))
    service.setEnabled(once.id, false)
    clock.advance(2 * HOUR)
    const renamed = service.update(once.id, { title: '新标题' })
    expect(renamed.title).toBe('新标题')
    expect(renamed.issue).toBeNull()
    expect(renamed.nextRunAt).toBeNull()
    expect(codeOf(() => service.setEnabled(once.id, true))).toBe('automations.invalid_schedule')
    service.update(once.id, { schedule: { cron: null, at: clock.now() + HOUR, timeZone: 'UTC' } })
    expect(service.setEnabled(once.id, true).enabled).toBe(true)
    db.close()
  })

  test('D5 只改别的字段不冲掉模型、思考强度、姿态（服务层合并）', () => {
    const { service, db } = buildCore()
    const a = service.create(
      fullDraft({ model: { provider: 'p', id: 'm' }, thinking: 'high', posture: 'full-access', notify: 'always' }),
    )
    const u = service.update(a.id, { title: '只改标题' })
    expect(u).toMatchObject({
      model: { provider: 'p', id: 'm' },
      thinking: 'high',
      posture: 'full-access',
      notify: 'always',
    })
    db.close()
  })

  test('D6 每次新开：threadId 一律清成 null', () => {
    const { service, conversation, db } = buildCore()
    const t = conversation.createThread({
      workspaceId: 'ws1',
      title: 'x',
      origin: 'user',
      posture: 'auto-edit',
      model: null,
      thinking: null,
    })
    expect(service.create(fullDraft({ threadMode: 'new', threadId: t.id })).threadId).toBeNull()
    db.close()
  })

  test('D7 续用：记着的对话不存在 / 不在任务的工作区 → invalid_thread', () => {
    const { service, conversation, db } = buildCore({
      workspaces: stubWorkspaces([testWorkspace('ws1'), testWorkspace('ws2', 'D:/ws2')]),
    })
    const other = conversation.createThread({
      workspaceId: 'ws2',
      title: 'x',
      origin: 'user',
      posture: 'auto-edit',
      model: null,
      thinking: null,
    })
    expect(codeOf(() => service.create(fullDraft({ threadMode: 'continue', threadId: 'nope' })))).toBe(
      'automations.invalid_thread',
    )
    expect(codeOf(() => service.create(fullDraft({ threadMode: 'continue', threadId: other.id })))).toBe(
      'automations.invalid_thread',
    )
    db.close()
  })

  test('D8 换工作区而没指定续用哪条：原来的续用对话作废（下次运行新建）', () => {
    const { service, conversation, db } = buildCore({
      workspaces: stubWorkspaces([testWorkspace('ws1'), testWorkspace('ws2', 'D:/ws2')]),
    })
    const t = conversation.createThread({
      workspaceId: 'ws1',
      title: 'x',
      origin: 'user',
      posture: 'auto-edit',
      model: null,
      thinking: null,
    })
    const a = service.create(fullDraft({ threadMode: 'continue', threadId: t.id }))
    expect(a.threadId).toBe(t.id)
    const moved = service.update(a.id, { workspaceId: 'ws2' })
    expect(moved.threadMode).toBe('continue')
    expect(moved.threadId).toBeNull()
    db.close()
  })
})
