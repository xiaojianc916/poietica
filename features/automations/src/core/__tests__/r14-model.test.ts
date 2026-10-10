import { describe, expect, test } from 'bun:test'
import { AppError } from '@poietica/foundation'
import { openDatabase } from '@poietica/storage-sqlite'
import { AutomationDraft, AutomationPatch } from '../../contract/entities'
import { migrations } from '../migrations'
import { buildCore, fullDraft, stubWorkspaces, testWorkspace } from './helpers'

/*
 * 审查 R-14：契约与数据模型。
 *   D1 更新用的 patch 不带默认值（zod 4 会在 .partial() 里套用 .default()，只改标题会把模型冲掉）；
 *   D2 迁移 v2 保住旧行；
 *   D3–D5 一次性计划的校验；
 *   D6–D8 续用对话的规矩。
 */

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
    /* 对照：旧写法确实会补默认值 —— 这就是 bug 的来源 */
    expect(AutomationDraft.partial().parse({ title: '改个名' })).toMatchObject({ posture: 'auto-edit', model: null })
  })

  test('D2 迁移 v2：旧任务与旧运行记录原样保留，新列取默认值', () => {
    const db = openDatabase(':memory:')
    const m = db.forModule('automations')
    m.exec(migrations[0]!.sql!)
    m.prepare(
      `INSERT INTO automations_automations (id, title, prompt, cron, time_zone, workspace_id, posture, enabled, created_at, updated_at)
       VALUES ('a1', 't', 'p', '0 9 * * *', 'UTC', 'ws1', 'auto-edit', 1, 0, 0)`,
    ).run()
    m.prepare(
      `INSERT INTO automations_runs (id, automation_id, thread_id, triggered_by, scheduled_for, started_at, settled_at, outcome, message)
       VALUES ('r1', 'a1', 'th1', 'schedule', 1, 2, 3, 'succeeded', NULL)`,
    ).run()
    m.exec(migrations[1]!.sql!)
    const a = m
      .prepare<{ thread_mode: string; notify: string; catch_up: number; run_at: number | null }>(
        'SELECT thread_mode, notify, catch_up, run_at FROM automations_automations',
      )
      .get()
    expect(a).toEqual({ thread_mode: 'new', notify: 'attention', catch_up: 1, run_at: null })
    const r = m
      .prepare<{ id: string; outcome: string; summary: string | null; attention: number }>(
        'SELECT id, outcome, summary, attention FROM automations_runs',
      )
      .get()
    expect(r).toEqual({ id: 'r1', outcome: 'succeeded', summary: null, attention: 0 })
    /* 新的结局与触发方式写得进去 */
    m.prepare(
      `INSERT INTO automations_runs (id, automation_id, triggered_by, started_at, outcome) VALUES ('r2', 'a1', 'catch_up', 5, 'skipped')`,
    ).run()
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
    /* 改成未来的时间就能再启用 */
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
