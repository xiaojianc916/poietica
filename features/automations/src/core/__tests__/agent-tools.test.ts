import { describe, expect, test } from 'bun:test'
import type { Controls, EngineToolContext, EngineToolSpec, ModelRef } from '@poietica/engine'
import { AppError } from '@poietica/foundation'
import { registerAgentTools } from '../agent-tools'
import { buildCore, fullDraft, stubWorkspaces, testWorkspace } from './helpers'

/*
 * 审查 R-15：定时任务的 agent 工具。直接调 execute（不经引擎），引擎只替 draftControls。
 *   T1 八张工具；T2 可选项；T3–T5 新建；T6 模型与思考强度校验；T7 「回到这条对话」；
 *   T8 修改只动给了的字段；T9 运行中不许管理任务；T10 汇报；T11 立即运行；T12 列表。
 */

const MODELS: readonly { ref: ModelRef; label: string }[] = [
  { ref: { provider: 'anthropic', id: 'claude-sonnet' }, label: 'Claude Sonnet' },
  { ref: { provider: 'openai', id: 'gpt-5' }, label: 'GPT-5' },
]

function controlsOf(model: ModelRef | null | undefined): Controls {
  const levels = model?.provider === 'openai' ? ['low', 'medium', 'high'] : ['off', 'high']
  return {
    model: {
      current: model ?? MODELS[0]!.ref,
      choices: MODELS.map((m) => ({ ...m, reasoning: true, images: true })),
    },
    thinking: { current: null, choices: levels.map((id) => ({ id, label: id })) },
    posture: 'auto-edit',
    planMode: false,
    goal: null,
  } as unknown as Controls
}

function rig() {
  const core = buildCore({ workspaces: stubWorkspaces([testWorkspace('ws1'), testWorkspace('ws2', 'D:/ws2')]) })
  const specs = new Map<string, EngineToolSpec>()
  registerAgentTools({
    tools: { register: (spec) => void specs.set(spec.name, spec) },
    service: core.service,
    conversation: core.conversation,
    workspaces: core.workspaces,
    engine: { draftControls: async (init) => controlsOf(init?.model) },
    clock: core.clock,
    localTimeZone: () => 'Asia/Shanghai',
  })
  const thread = core.conversation.createThread({
    workspaceId: 'ws1',
    title: '用户对话',
    origin: 'user',
    posture: 'auto-edit',
    model: null,
    thinking: null,
  })
  const ctx: EngineToolContext = { cwd: 'D:/ws', signal: new AbortController().signal, sessionKey: thread.id }
  /* 工具结果是 JSON 文本，测试按字段断言：any 的例外登记在 biome.json 的 overrides（审查 R-15） */
  const call = async (name: string, params: unknown, c: EngineToolContext = ctx): Promise<any> => {
    const spec = specs.get(name)
    if (spec === undefined) throw new Error(`没有注册 ${name}`)
    const parsed = spec.parameters.parse(params)
    return JSON.parse((await spec.execute(parsed, c)).text)
  }
  const fails = async (name: string, params: unknown, c: EngineToolContext = ctx): Promise<AppError> => {
    try {
      await call(name, params, c)
    } catch (e) {
      if (e instanceof AppError) return e
      throw e
    }
    throw new Error(`${name} 应当失败`)
  }
  return { ...core, specs, thread, ctx, call, fails }
}

const DAILY = { type: 'cron', cron: '0 9 * * *' } as const

describe('R-15 定时任务 agent 工具', () => {
  test('T1 八张工具，读的是 read、改的是 write', () => {
    const { specs, db } = rig()
    const approvals = Object.fromEntries([...specs.values()].map((s) => [s.name, s.approval]))
    expect(approvals).toEqual({
      automation_options: 'read',
      automation_list: 'read',
      automation_runs: 'read',
      automation_create: 'write',
      automation_update: 'write',
      automation_run: 'write',
      automation_delete: 'write',
      automation_report: 'read',
    })
    db.close()
  })

  test('T2 可选项：用户时区的当前时间（带时差）、工作区、模型、思考档位', async () => {
    const { call, thread, db } = rig()
    const o = await call('automation_options', {})
    expect(o.timeZone).toBe('Asia/Shanghai')
    expect(o.now).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/)
    expect(o.currentWorkspaceId).toBe('ws1')
    expect(o.workspaces.map((w: { id: string }) => w.id)).toEqual(['ws1', 'ws2'])
    expect(o.models).toContainEqual({ provider: 'openai', id: 'gpt-5', label: 'GPT-5' })
    expect(o.thinkingLevels.map((t: { id: string }) => t.id)).toEqual(['off', 'high'])
    const forGpt = await call('automation_options', { model: { provider: 'openai', id: 'gpt-5' } })
    expect(forGpt.thinkingLevels.map((t: { id: string }) => t.id)).toEqual(['low', 'medium', 'high'])
    expect(thread.workspaceId).toBe('ws1')
    db.close()
  })

  test('T3 新建的默认值：当前对话的工作区、用户时区、auto-edit、需要关注才通知；结果带接下来三次', async () => {
    const { call, db } = rig()
    const v = await call('automation_create', { title: '晨报', prompt: '汇总', schedule: DAILY })
    expect(v).toMatchObject({
      title: '晨报',
      enabled: true,
      schedule: { type: 'cron', cron: '0 9 * * *', timeZone: 'Asia/Shanghai' },
      workspace: { id: 'ws1', name: 'ws1' },
      model: null,
      posture: 'auto-edit',
      thread: 'new',
      notify: 'attention',
      catchUp: true,
    })
    expect(v.upcoming).toHaveLength(3)
    expect(v.upcoming[0]).toMatch(/T09:00:00\+08:00$/)
    db.close()
  })

  test('T4 指定别的工作区、模型、思考强度、通知；不可用的工作区报错', async () => {
    const { call, fails, db } = rig()
    const v = await call('automation_create', {
      title: '周报',
      prompt: '写周报',
      schedule: { type: 'cron', cron: '0 18 * * 5' },
      workspaceId: 'ws2',
      model: { provider: 'openai', id: 'gpt-5' },
      thinking: 'medium',
      notify: 'always',
    })
    expect(v).toMatchObject({
      workspace: { id: 'ws2' },
      model: { provider: 'openai', id: 'gpt-5', label: 'GPT-5' },
      thinking: 'medium',
      notify: 'always',
    })
    const e = await fails('automation_create', { title: 'x', prompt: 'y', schedule: DAILY, workspaceId: 'nope' })
    expect(e.message).toContain('nope')
    db.close()
  })

  test('T5 一次性：带时差的 ISO 收；不带时差、cron 缺表达式都给中文错误', async () => {
    const { call, fails, clock, db } = rig()
    const at = new Date(clock.now() + 2 * 3_600_000).toISOString()
    const v = await call('automation_create', { title: '提醒', prompt: '看构建', schedule: { type: 'once', at } })
    expect(v.schedule.type).toBe('once')
    expect(Date.parse(v.schedule.at)).toBe(Date.parse(at))
    expect(v.upcoming).toHaveLength(1)
    expect(
      (
        await fails('automation_create', {
          title: 'x',
          prompt: 'y',
          schedule: { type: 'once', at: '2030-01-01T09:00' },
        })
      ).message,
    ).toContain('带时差')
    expect(
      (await fails('automation_create', { title: 'x', prompt: 'y', schedule: { type: 'cron' } })).message,
    ).toContain('schedule.cron')
    db.close()
  })

  test('T6 模型、思考强度不在可选表里：报错并列出可选值', async () => {
    const { fails, db } = rig()
    const m = await fails('automation_create', {
      title: 'x',
      prompt: 'y',
      schedule: DAILY,
      model: { provider: 'x', id: 'nope' },
    })
    expect(m.message).toContain('anthropic/claude-sonnet、openai/gpt-5')
    const t = await fails('automation_create', {
      title: 'x',
      prompt: 'y',
      schedule: DAILY,
      model: { provider: 'openai', id: 'gpt-5' },
      thinking: 'max',
    })
    expect(t.message).toContain('low、medium、high')
    db.close()
  })

  test('T7 thread=this：每次运行续用这条对话；配别的工作区报错', async () => {
    const { call, fails, thread, db } = rig()
    const v = await call('automation_create', {
      title: '回头看',
      prompt: '构建好了没',
      schedule: { type: 'manual' },
      thread: 'this',
    })
    expect(v).toMatchObject({ thread: 'this', threadId: thread.id })
    const e = await fails('automation_create', {
      title: 'x',
      prompt: 'y',
      schedule: DAILY,
      thread: 'this',
      workspaceId: 'ws2',
    })
    expect(e.message).toContain('this')
    db.close()
  })

  test('T8 修改只动给了的字段；enabled=false 暂停', async () => {
    const { call, db } = rig()
    const v = await call('automation_create', {
      title: '周报',
      prompt: '写周报',
      schedule: DAILY,
      model: { provider: 'openai', id: 'gpt-5' },
      thinking: 'high',
      posture: 'full-access',
    })
    const u = await call('automation_update', { id: v.id, title: '周报（新）', enabled: false })
    expect(u).toMatchObject({
      title: '周报（新）',
      enabled: false,
      model: { provider: 'openai', id: 'gpt-5' },
      thinking: 'high',
      posture: 'full-access',
      schedule: { type: 'cron', cron: '0 9 * * *' },
    })
    db.close()
  })

  test('T9 定时任务运行中：不许建、改、删、手动运行；查询与汇报照常', async () => {
    const { call, fails, service, db } = rig()
    const a = service.create(fullDraft({ workspaceId: 'ws1' }))
    const run = await service.runNow(a.id)
    const inRun: EngineToolContext = { cwd: 'D:/ws', signal: new AbortController().signal, sessionKey: run.threadId! }
    for (const [name, params] of [
      ['automation_create', { title: 'x', prompt: 'y', schedule: DAILY }],
      ['automation_update', { id: a.id, title: 'z' }],
      ['automation_delete', { id: a.id }],
      ['automation_run', { id: a.id }],
    ] as const) {
      expect((await fails(name, params, inRun)).code).toBe('automations.forbidden_in_run')
    }
    expect(await call('automation_list', {}, inRun)).toHaveLength(1)
    expect((await call('automation_runs', { id: a.id }, inRun)).runs).toHaveLength(1)
    expect(await call('automation_report', { summary: '一切正常' }, inRun)).toMatchObject({ reported: true })
    db.close()
  })

  test('T10 汇报：不在运行中的对话里调 → not_in_run', async () => {
    const { fails, db } = rig()
    expect((await fails('automation_report', { summary: '随便说说' })).code).toBe('automations.not_in_run')
    db.close()
  })

  test('T11 立即运行：交回运行与它的对话', async () => {
    const { call, db } = rig()
    const v = await call('automation_create', { title: '巡检', prompt: '看 CI', schedule: { type: 'manual' } })
    const r = await call('automation_run', { id: v.id })
    expect(r).toMatchObject({ id: v.id, title: '巡检', run: { outcome: 'running', trigger: 'manual' } })
    expect(r.run.threadId).not.toBeNull()
    db.close()
  })

  test('T12 列表：可按工作区筛选，带上次运行的结论', async () => {
    const { call, service, runner, db } = rig()
    const a = service.create(fullDraft({ workspaceId: 'ws1', title: 'A' }))
    service.create(fullDraft({ workspaceId: 'ws2', title: 'B' }))
    const run = await service.runNow(a.id)
    service.report(run.threadId!, '没有新问题', false)
    runner.onTurnSettled({ threadId: run.threadId!, outcome: 'completed', error: null })
    const rows = await call('automation_list', { workspaceId: 'ws1' })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ title: 'A', lastRun: { outcome: 'succeeded', summary: '没有新问题' } })
    db.close()
  })
})
