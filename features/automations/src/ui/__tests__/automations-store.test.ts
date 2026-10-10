import { describe, expect, test } from 'bun:test'
import { createTestLogger } from '@poietica/test-kit'
import type { Automation, AutomationRun, Schedule, ScheduleProblem } from '../../contract'
import type { AutomationsApi } from '../api'
import { createAutomationsStore, RUNS_LIMIT } from '../automations-store'

/*
 * store 的行为（逐条对照 legacy `packages/automation/src/automation-store.ts` 的测试口径）：
 *   - changed → refresh；runUpdated → 只更新缓存里的那一条；
 *   - 写入成功把返回值并进列表；命令去重（同键只发一次）；
 *   - 历史上限与 RUNS_LIMIT 对齐；
 *   - 读失败会写进 error（loaded 仍为 true），订阅失败写 watchError。
 */

function automation(id: string, over: Partial<Automation> = {}): Automation {
  return {
    id,
    title: `任务 ${id}`,
    prompt: '跑一次',
    schedule: { cron: '0 9 * * *', at: null, timeZone: 'Asia/Shanghai' },
    workspaceId: 'ws1',
    posture: 'auto-edit',
    model: null,
    thinking: null,
    threadMode: 'new',
    threadId: null,
    notify: 'attention',
    catchUp: true,
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
    nextRunAt: null,
    issue: null,
    lastRun: null,
    ...over,
  }
}

function run(id: string, automationId: string, over: Partial<AutomationRun> = {}): AutomationRun {
  return {
    id,
    automationId,
    threadId: null,
    trigger: 'manual',
    scheduledFor: null,
    startedAt: 0,
    settledAt: null,
    outcome: 'running',
    message: null,
    summary: null,
    attention: false,
    ...over,
  }
}

interface FakeApi extends AutomationsApi {
  readonly calls: string[]
  changed: (() => void) | null
  runUpdated: ((r: AutomationRun) => void) | null
  listed: Automation[]
  readonly runsById: Record<string, AutomationRun[]>
  failList: boolean
}

function fakeApi(): FakeApi {
  const calls: string[] = []
  const api: FakeApi = {
    calls,
    changed: null,
    runUpdated: null,
    listed: [],
    runsById: {},
    failList: false,
    async list() {
      calls.push('list')
      if (api.failList) {
        throw new Error('目录炸了')
      }
      return [...api.listed]
    },
    async get(automationId) {
      const found = api.listed.find((a) => a.id === automationId)
      if (found === undefined) {
        throw new Error('not found')
      }
      return found
    },
    async create(draft) {
      calls.push('create')
      const created = automation('new', {
        title: draft.title,
        prompt: draft.prompt,
        schedule: draft.schedule,
        workspaceId: draft.workspaceId,
        posture: draft.posture,
      })
      api.listed = [created, ...api.listed]
      return created
    },
    async update(id, patch) {
      calls.push(`update:${id}`)
      const current = api.listed.find((a) => a.id === id)
      if (current === undefined) {
        throw new Error('not found')
      }
      const next = { ...current, ...patch }
      api.listed = api.listed.map((a) => (a.id === id ? next : a))
      return next
    },
    async remove(id) {
      calls.push(`remove:${id}`)
      api.listed = api.listed.filter((a) => a.id !== id)
    },
    async setEnabled(id, enabled) {
      calls.push(`enable:${id}:${String(enabled)}`)
      const current = api.listed.find((a) => a.id === id)
      if (current === undefined) {
        throw new Error('not found')
      }
      return { ...current, enabled }
    },
    async runNow(id) {
      calls.push(`run:${id}`)
      return run('r1', id)
    },
    async cancelRun(runId) {
      calls.push(`cancel:${runId}`)
    },
    async runs(automationId) {
      calls.push(`runs:${automationId}`)
      return [...(api.runsById[automationId] ?? [])]
    },
    async previewSchedule(
      _schedule: Schedule,
      count: number,
    ): Promise<{ times: number[]; problem: ScheduleProblem | null }> {
      calls.push(`preview:${String(count)}`)
      return { times: [1], problem: null }
    },
    onChanged(listener) {
      api.changed = listener
      return {
        dispose: () => {
          api.changed = null
        },
      }
    },
    onRunUpdated(listener) {
      api.runUpdated = listener
      return {
        dispose: () => {
          api.runUpdated = null
        },
      }
    },
  }
  return api
}

function build(): { api: FakeApi; store: ReturnType<typeof createAutomationsStore> } {
  const api = fakeApi()
  const store = createAutomationsStore({ api, logger: createTestLogger() })
  return { api, store }
}

describe('automations store', () => {
  test('refresh：目录与历史分别读，loaded 与 runs 对得上', async () => {
    const { api, store } = build()
    api.listed = [automation('a1'), automation('a2')]
    api.runsById.a1 = [run('r1', 'a1')]
    await store.refresh()
    const state = store.store.getState()
    expect(state.loaded).toBe(true)
    expect(state.automations.map((a) => a.id)).toEqual(['a1', 'a2'])
    expect(state.runs.a1?.length).toBe(1)
    expect(state.runs.a2).toEqual([])
  })

  test('读失败写进 error，loaded 仍为 true', async () => {
    const { api, store } = build()
    api.failList = true
    await store.refresh()
    const state = store.store.getState()
    expect(state.loaded).toBe(true)
    expect(state.error).toContain('自动化目录读取失败')
  })

  test('runUpdated：只更新缓存里的那一条，不整表重拉', async () => {
    const { api, store } = build()
    api.listed = [automation('a1')]
    api.runsById.a1 = [run('r1', 'a1')]
    const stop = store.start()
    await store.refresh()
    const before = api.calls.length
    api.runUpdated?.(run('r1', 'a1', { outcome: 'succeeded', settledAt: 5 }))
    const state = store.store.getState()
    expect(state.runs.a1?.[0]?.outcome).toBe('succeeded')
    expect(api.calls.length).toBe(before)
    stop()
  })

  test('changed：重新读目录', async () => {
    const { api, store } = build()
    api.listed = [automation('a1')]
    const stop = store.start()
    await store.refresh()
    api.listed = [automation('a1'), automation('a2')]
    api.changed?.()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(store.store.getState().automations.length).toBe(2)
    stop()
  })

  test('create/update/remove：返回值并进列表', async () => {
    const { store } = build()
    expect(await store.create(automation('x'))).toBe(true)
    expect(store.store.getState().automations[0]?.id).toBe('new')
    expect(await store.update('new', automation('new', { title: '改过' }), false)).toBe(true)
    expect(store.store.getState().automations[0]?.title).toBe('改过')
    expect(await store.remove('new')).toBe(true)
    expect(store.store.getState().automations).toEqual([])
  })

  test('历史上限与 RUNS_LIMIT 对齐（50）', () => {
    expect(RUNS_LIMIT).toBe(50)
  })

  test('start 只能起一次；dispose 后可以再起', () => {
    const { store } = build()
    const stop = store.start()
    expect(() => store.start()).toThrow()
    stop()
    const stopAgain = store.start()
    stopAgain()
  })
})
