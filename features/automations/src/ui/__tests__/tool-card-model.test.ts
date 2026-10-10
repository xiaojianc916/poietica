import { describe, expect, test } from 'bun:test'
import { describePlan, hasPlan } from '../automation'
import { atOfLocalInput, defaultOnceAt, localInputOf } from '../automation-schedule-field'
import { changedOf, clockText, resultText, toolCardOf } from '../tool-card-model'

/*
 * 审查 R-16：对话里「定时任务」工具卡的读法（toolCardOf 是纯函数，卡片只画它的结果）。
 *   C1 新建；C2 修改的「已修改」；C3 一次性与跑完；C4 列表；C5 运行记录；C6 汇报；
 *   C7 进行中与失败；C8 结果的几种外形；C9 删除与立即运行；C10 可选项；
 *   C11 编辑器的一次性时间换算与计划人话。
 * 结果 JSON 的字段名是 R-15 §3.3 的规格。
 */

const TZ = 'Asia/Shanghai'

function view(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'a1',
    title: '每日 CI 巡检',
    prompt: '检查 main 分支最近的 CI 失败\n汇总原因',
    enabled: true,
    schedule: { type: 'cron', cron: '0 9 * * 1-5', timeZone: TZ },
    nextRunAt: '2026-05-04T09:00:00+08:00',
    workspace: { id: 'ws1', name: 'poietica' },
    model: { provider: 'anthropic', id: 'claude-sonnet', label: 'Claude Sonnet' },
    thinking: 'high',
    posture: 'auto-edit',
    thread: 'new',
    threadId: null,
    notify: 'attention',
    catchUp: true,
    issue: null,
    lastRun: null,
    ...over,
  }
}

const ok = (value: unknown) => ({ text: JSON.stringify(value) })

describe('R-16 定时任务工具卡', () => {
  test('C1 新建：一句话、计划、下次、元信息、接下来三次（按任务时区）', () => {
    const card = toolCardOf(
      'automation_create',
      { title: '每日 CI 巡检' },
      ok({
        ...view(),
        upcoming: ['2026-05-04T09:00:00+08:00', '2026-05-05T09:00:00+08:00', '2026-05-06T09:00:00+08:00'],
      }),
      'succeeded',
    )
    expect(card.line).toBe('创建了定时任务 · 每日 CI 巡检')
    expect(card.error).toBeNull()
    if (card.body.kind !== 'automation') throw new Error('应当是任务卡')
    const a = card.body.automation
    expect(a.plan).toBe('每工作日 09:00')
    expect(a.state).toEqual({ label: '已启用', tone: 'success' })
    expect(a.nextRunAt).toBe(Date.parse('2026-05-04T09:00:00+08:00'))
    expect(a.upcoming).toEqual(['05-04 09:00', '05-05 09:00', '05-06 09:00'])
    expect(a.meta).toEqual([
      { label: '工作区', value: 'poietica' },
      { label: '模型', value: 'Claude Sonnet · 深度思考' },
      { label: '对话', value: '每次新开' },
      { label: '通知', value: '需要关注时' },
      { label: '权限', value: '自动编辑' },
    ])
    expect(a.once).toBe(false)
    expect(card.body.changed).toEqual([])
  })

  test('C2 修改：「已修改」读调用参数给了哪些键；enabled 说成暂停 / 恢复', () => {
    const card = toolCardOf('automation_update', { id: 'a1', title: '新名字', model: null }, ok(view()), 'succeeded')
    expect(card.line).toBe('修改了定时任务 · 每日 CI 巡检')
    if (card.body.kind !== 'automation') throw new Error('应当是任务卡')
    expect(card.body.changed).toEqual(['标题', '模型'])
    expect(changedOf({ id: 'a1', enabled: false })).toEqual(['暂停'])
    expect(changedOf({ id: 'a1', enabled: true, notify: 'never' })).toEqual(['通知', '恢复'])
  })

  test('C3 一次性：计划写时刻；跑完（停用且没有下次）是「已完成」，暂停的周期任务是「已暂停」', () => {
    const once = view({ schedule: { type: 'once', at: '2026-05-02T09:00:00+08:00', timeZone: TZ } })
    const live = toolCardOf('automation_create', {}, ok(once), 'succeeded')
    if (live.body.kind !== 'automation') throw new Error('应当是任务卡')
    expect(live.body.automation.plan).toBe('一次 · 05-02 09:00')
    expect(live.body.automation.once).toBe(true)

    const done = toolCardOf('automation_update', {}, ok({ ...once, enabled: false, nextRunAt: null }), 'succeeded')
    if (done.body.kind !== 'automation') throw new Error('应当是任务卡')
    expect(done.body.automation.state).toEqual({ label: '已完成', tone: 'quiet' })

    const paused = toolCardOf('automation_update', {}, ok(view({ enabled: false })), 'succeeded')
    if (paused.body.kind !== 'automation') throw new Error('应当是任务卡')
    expect(paused.body.automation.state.label).toBe('已暂停')

    const manual = toolCardOf(
      'automation_create',
      {},
      ok(view({ schedule: { type: 'manual', timeZone: TZ } })),
      'succeeded',
    )
    if (manual.body.kind !== 'automation') throw new Error('应当是任务卡')
    expect(manual.body.automation.plan).toBe('仅手动运行')

    const broken = toolCardOf('automation_create', {}, ok(view({ issue: '无法识别' })), 'succeeded')
    if (broken.body.kind !== 'automation') throw new Error('应当是任务卡')
    expect(broken.body.automation.state).toEqual({ label: '计划有问题', tone: 'warning' })
  })

  test('C4 列表：最多 6 行，多的写「还有 N 个」；行尾是上次结局', () => {
    const rows = Array.from({ length: 8 }, (_, i) =>
      view({ id: `a${i}`, title: `任务 ${i}`, lastRun: i === 0 ? { id: 'r', outcome: 'failed' } : null }),
    )
    const card = toolCardOf('automation_list', {}, ok(rows), 'succeeded')
    expect(card.line).toBe('列出了定时任务')
    expect(card.hint).toBe('8 个')
    if (card.body.kind !== 'list') throw new Error('应当是列表')
    expect(card.body.rows).toHaveLength(6)
    expect(card.body.more).toBe(2)
    expect(card.body.rows[0]).toEqual({
      id: 'a0',
      title: '任务 0',
      plan: '每工作日 09:00',
      tone: 'success',
      last: '上次失败',
      lastTone: 'danger',
    })
    expect(card.body.rows[1]?.last).toBeNull()
  })

  test('C5 运行记录：结局符号、补跑 / 手动标签、结论优先于系统消息', () => {
    const card = toolCardOf(
      'automation_runs',
      { id: 'a1' },
      ok({
        id: 'a1',
        title: '每日 CI 巡检',
        runs: [
          {
            id: 'r1',
            outcome: 'succeeded',
            trigger: 'catch_up',
            startedAt: '2026-05-04T09:00:30+08:00',
            summary: '全绿',
            message: null,
            threadId: 't1',
          },
          {
            id: 'r2',
            outcome: 'skipped',
            trigger: 'schedule',
            startedAt: '2026-05-03T09:00:00+08:00',
            summary: null,
            message: '上一次运行还没结束',
            threadId: null,
          },
          {
            id: 'r3',
            outcome: 'weird',
            trigger: 'manual',
            startedAt: 'bad',
            summary: null,
            message: null,
            threadId: null,
          },
        ],
      }),
      'succeeded',
    )
    expect(card.line).toBe('查看了运行记录 · 每日 CI 巡检')
    expect(card.hint).toBe('最近 3 次')
    if (card.body.kind !== 'runs') throw new Error('应当是运行记录')
    const [r1, r2, r3] = card.body.rows
    expect(r1).toMatchObject({ glyph: 'succeeded', tag: '补跑', text: '全绿', threadId: 't1' })
    expect(r2).toMatchObject({ glyph: 'skipped', tag: null, text: '上一次运行还没结束', threadId: null })
    expect(r3).toMatchObject({ glyph: 'cancelled', tag: '手动', when: '—', text: null })
  })

  test('C6 汇报：结论原文；attention 标出来', () => {
    const card = toolCardOf(
      'automation_report',
      { summary: '有 2 个测试失败', attention: true },
      ok({ reported: true, summary: '有 2 个测试失败', attention: true }),
      'succeeded',
    )
    expect(card.line).toBe('汇报了本次结果')
    expect(card.body).toEqual({ kind: 'report', summary: '有 2 个测试失败', attention: true })
  })

  test('C7 进行中读参数里的标题；失败给原话、不画卡', () => {
    const running = toolCardOf('automation_create', { title: '巡检' }, null, 'running')
    expect(running.line).toBe('正在创建定时任务 · 巡检')
    expect(running.body).toEqual({ kind: 'none' })

    const failed = toolCardOf('automation_create', { title: '巡检' }, { text: '模型 x/y 不可用。可选：…' }, 'failed')
    expect(failed.line).toBe('创建定时任务失败 · 巡检')
    expect(failed.error).toBe('模型 x/y 不可用。可选：…')
    expect(failed.body).toEqual({ kind: 'none' })

    expect(toolCardOf('automation_delete', {}, { error: '找不到任务' }, 'failed').error).toBe('找不到任务')
    expect(toolCardOf('automation_delete', {}, ok({ message: '定时任务运行中不能删除' }), 'failed').error).toBe(
      '定时任务运行中不能删除',
    )
  })

  test('C8 结果的几种外形：{text}、{content:[text]}、字符串都认；读不懂的只画一行', () => {
    const json = JSON.stringify(view())
    expect(resultText({ content: [{ type: 'text', text: json }] })).toBe(json)
    expect(resultText(json)).toBe(json)
    expect(resultText({ content: [{ type: 'image', data: 'x' }] })).toBeNull()
    const card = toolCardOf(
      'automation_create',
      { title: 'x' },
      { content: [{ type: 'text', text: json }] },
      'succeeded',
    )
    expect(card.body.kind).toBe('automation')
    const garbage = toolCardOf('automation_create', { title: 'x' }, { text: 'not json' }, 'succeeded')
    expect(garbage.line).toBe('创建了定时任务 · x')
    expect(garbage.body).toEqual({ kind: 'none' })
  })

  test('C9 删除只有一行；立即运行带出那次运行的对话', () => {
    const removed = toolCardOf(
      'automation_delete',
      { id: 'a1' },
      ok({ id: 'a1', title: '巡检', removed: true }),
      'succeeded',
    )
    expect(removed.line).toBe('删除了定时任务 · 巡检')
    expect(removed.body).toEqual({ kind: 'none' })

    const run = toolCardOf(
      'automation_run',
      { id: 'a1' },
      ok({ id: 'a1', title: '巡检', run: { id: 'r1', outcome: 'running', threadId: 't9' } }),
      'succeeded',
    )
    expect(run.line).toBe('启动了定时任务 · 巡检')
    expect(run.body).toEqual({ kind: 'run', automationId: 'a1', threadId: 't9' })
  })

  test('C10 可选项：安静的一行，行尾写数量', () => {
    const card = toolCardOf(
      'automation_options',
      {},
      ok({ now: '2026-05-01T10:00:00+08:00', workspaces: [{ id: 'w' }, { id: 'v' }], models: [{ id: 'm' }] }),
      'succeeded',
    )
    expect(card.line).toBe('查看了定时任务可选项')
    expect(card.hint).toBe('2 个工作区 · 1 个模型')
    expect(card.body).toEqual({ kind: 'none' })
  })

  test('C11 编辑器：一次性时间与 datetime-local 往返；默认是明天 09:00；计划人话', () => {
    const at = new Date(2026, 4, 2, 9, 30).getTime()
    expect(localInputOf(at)).toBe('2026-05-02T09:30')
    expect(atOfLocalInput('2026-05-02T09:30')).toBe(at)
    expect(atOfLocalInput('2026-05-02')).toBeNull()
    expect(defaultOnceAt(new Date(2026, 4, 1, 22, 0).getTime())).toBe(new Date(2026, 4, 2, 9, 0).getTime())
    expect(describePlan({ cron: null, at })).toBe('一次 · 05-02 09:30')
    expect(describePlan({ cron: '0 9 * * *', at: null })).toBe('每天 09:00')
    expect(describePlan({ cron: null, at: null })).toBe('手动')
    expect(hasPlan({ cron: null, at: null })).toBe(false)
    expect(clockText('2026-05-02T01:00:00Z', TZ)).toBe('05-02 09:00')
    expect(clockText('nope', TZ)).toBeNull()
  })
})
