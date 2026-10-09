import { invariant, type Logger } from '@poietica/foundation'
import { createFeatureStore, type FeatureStore } from '@poietica/ui-kernel'
import type { Automation, AutomationDraft, AutomationRun, Schedule, ScheduleProblem } from '../contract'
import type { AutomationsApi } from './api'

/*
 * 照 legacy `packages/automation/src/automation-store.ts` 搬迁：界面要的那几格
 * （automations / loaded / error / watchError / pending）与「命令回执去重」的脾气
 * 一字未改，换的是数据的来路与去处。
 *
 * legacy 的目录快照带 revision，写入靠 expectedRevision 做乐观并发；新契约（07 页
 * §9B/§11.9）没有 revision，RPC 每次写都返回最新的那一条，读侧靠 changed /
 * runUpdated 两条通知对账。因此：写入成功后直接把返回值并回列表，不认识的变更由
 * changed → refresh 兜底。
 *
 * 运行记录不进 automation 实体（实体只带 lastRun），列表页要显示「已运行 N 次」、
 * 编辑页要显示完整历史，所以这里按 id 拉 `automations.runs`（历史上限 50 由 Core 保证）
 * 并缓存。runUpdated 到达时只更新缓存里的那一条，不整表重拉。
 */

/** 一次取整条历史的上限：Core 每个任务只保留最近 50 条，这里直接对齐。 */
export const RUNS_LIMIT = 50

export interface AutomationsViewModel {
  readonly automations: readonly Automation[]
  readonly runs: Readonly<Record<string, readonly AutomationRun[]>>
  readonly loaded: boolean
  readonly error: string | null
  readonly watchError: string | null
  readonly pending: readonly string[]
}

export interface AutomationsStore {
  readonly store: FeatureStore<AutomationsViewModel>
  /**
   * 列表表面点「创建/模板」后交给编辑表面的草稿。
   *
   * 两个表面在路由上各是一次挂载，草稿没法当 props 传；legacy 里它是 surface 的内部
   * state，新架构把它暂存在 store 上（不是持久状态，只是两个表面之间的一次交接——
   * 编辑表面读走即清空）。
   */
  pendingDraft: AutomationDraft | null
  readonly create: (draft: AutomationDraft) => Promise<boolean>
  readonly update: (id: string, draft: AutomationDraft, enabled: boolean) => Promise<boolean>
  readonly remove: (id: string) => Promise<boolean>
  readonly setEnabled: (id: string, enabled: boolean) => Promise<boolean>
  readonly runNow: (id: string) => Promise<boolean>
  readonly cancel: (runId: string) => Promise<boolean>
  readonly preview: (schedule: Schedule, count: number) => Promise<{ times: number[]; problem: ScheduleProblem | null }>
  readonly refresh: () => Promise<boolean>
  readonly start: () => () => void
}

const EMPTY: AutomationsViewModel = {
  automations: [],
  runs: {},
  loaded: false,
  error: null,
  watchError: null,
  pending: [],
}

/** 只读修复：订阅断掉或漏了通知时，靠它把目录重新对齐（legacy 同此）。 */
const REPAIR_INTERVAL_MS = 15_000

export function createAutomationsStore(d: { readonly api: AutomationsApi; readonly logger: Logger }): AutomationsStore {
  const { api, logger } = d
  const store = createFeatureStore<AutomationsViewModel>(() => EMPTY)
  let snapshot = EMPTY
  const commands = new Map<string, Promise<boolean>>()
  let generation = 0
  let started = false
  let reading: Promise<boolean> | null = null

  const publish = (patch: Partial<AutomationsViewModel>): void => {
    snapshot = { ...snapshot, ...patch }
    store.setState(snapshot)
  }

  const failure = (operation: string, cause: unknown): string => {
    logger.warn(operation, { error: cause instanceof Error ? cause.message : String(cause) })
    const detail = cause instanceof Error ? cause.message : String(cause)
    return [operation, detail].join('：')
  }

  /** 把一条新记录并进列表（新增追加、已有替换）；排序仍由 Core 的 created_at DESC 决定 */
  const upsertAutomation = (automation: Automation): void => {
    const found = snapshot.automations.some((row) => row.id === automation.id)
    const automations = found
      ? snapshot.automations.map((row) => (row.id === automation.id ? automation : row))
      : [automation, ...snapshot.automations]
    publish({ automations })
  }

  const applyRunUpdated = (run: AutomationRun): void => {
    const known = snapshot.runs[run.automationId] ?? []
    const runs = known.some((row) => row.id === run.id)
      ? known.map((row) => (row.id === run.id ? run : row))
      : [run, ...known].slice(0, RUNS_LIMIT)
    publish({ runs: { ...snapshot.runs, [run.automationId]: runs } })
  }

  async function loadRuns(automationId: string): Promise<void> {
    try {
      const runs = await api.runs(automationId, RUNS_LIMIT)
      publish({ runs: { ...snapshot.runs, [automationId]: runs } })
    } catch (cause) {
      /* 历史读不到不该让整个列表变红：留在「已运行 0 次」，下一次 refresh 再对。 */
      logger.warn('运行历史读取失败', { automationId, error: String(cause) })
    }
  }

  async function refresh(): Promise<boolean> {
    if (reading !== null) {
      return reading
    }
    const owner = generation
    const request = api.list().then(
      async (automations) => {
        if (owner !== generation) {
          return true
        }
        publish({ automations, loaded: true, error: null })
        /* 历史与目录分别读：一个任务的运行记录读失败不牵连其余 */
        await Promise.all(
          automations.map(async (automation) => {
            if (owner === generation) {
              await loadRuns(automation.id)
            }
          }),
        )
        return true
      },
      (cause: unknown) => {
        if (owner === generation) {
          publish({ error: failure('自动化目录读取失败', cause), loaded: true })
        }
        return false
      },
    )
    reading = request
    try {
      return await request
    } finally {
      if (reading === request) {
        reading = null
      }
    }
  }

  function command(key: string, operation: string, send: () => Promise<void>): Promise<boolean> {
    const pending = commands.get(key)
    if (pending !== undefined) {
      return pending
    }
    const owner = generation
    publish({ error: null })
    const receipt = Promise.resolve()
      .then(send)
      .then(
        () => true,
        (cause: unknown) => {
          const message = failure(operation, cause)
          if (owner === generation) {
            publish({ error: message })
          }
          return false
        },
      )
      .finally(() => {
        commands.delete(key)
        publish({ pending: [...commands.keys()] })
      })
    commands.set(key, receipt)
    publish({ pending: [...commands.keys()] })
    return receipt
  }

  return {
    store,
    pendingDraft: null,
    create: (draft) =>
      command('create', '创建失败', async () => {
        upsertAutomation(await api.create(draft))
      }),
    update: (id, draft, enabled) =>
      command(`update:${id}`, '保存失败，草稿未覆盖', async () => {
        const saved = await api.update(id, draft)
        upsertAutomation(saved.enabled === enabled ? saved : await api.setEnabled(id, enabled))
      }),
    remove: (id) =>
      command(`remove:${id}`, '删除失败', async () => {
        await api.remove(id)
        if (snapshot.automations.some((row) => row.id === id)) {
          const runs = { ...snapshot.runs }
          delete runs[id]
          publish({ automations: snapshot.automations.filter((row) => row.id !== id), runs })
        }
      }),
    setEnabled: (id, enabled) =>
      command(`enable:${id}`, '修改计划状态失败', async () => {
        upsertAutomation(await api.setEnabled(id, enabled))
      }),
    runNow: (id) =>
      command(`run:${id}`, '运行请求未确认', async () => {
        applyRunUpdated(await api.runNow(id))
      }),
    cancel: (runId) =>
      command(`cancel:${runId}`, '停止请求未确认', async () => {
        await api.cancelRun(runId)
      }),
    preview: (schedule, count) => api.previewSchedule(schedule, count),
    refresh,
    start() {
      if (started) {
        invariant(false, 'Automation catalog observation is already started')
      }
      started = true
      generation += 1
      reading = null
      const owner = generation
      let disposed = false
      const subscriptions: { dispose(): void }[] = []

      const attach = (): void => {
        if (disposed || generation !== owner) {
          return
        }
        try {
          subscriptions.push(
            api.onChanged(() => {
              if (generation === owner) {
                void refresh()
              }
            }),
          )
          subscriptions.push(
            api.onRunUpdated((run) => {
              if (generation === owner) {
                applyRunUpdated(run)
              }
            }),
          )
          publish({ watchError: null })
        } catch (cause: unknown) {
          publish({ watchError: failure('自动化更新订阅失败，正在通过读取核对', cause) })
        }
      }

      attach()
      void refresh()
      /* 只读修复轮询：不能认领也不能提交任何工作（legacy 同此）。 */
      const timer = setInterval(() => {
        void refresh()
      }, REPAIR_INTERVAL_MS)
      return () => {
        if (generation !== owner) {
          return
        }
        generation += 1
        started = false
        disposed = true
        reading = null
        clearInterval(timer)
        for (const subscription of subscriptions.splice(0)) {
          try {
            subscription.dispose()
          } catch (cause: unknown) {
            failure('自动化更新订阅未能释放', cause)
          }
        }
      }
    },
  }
}
