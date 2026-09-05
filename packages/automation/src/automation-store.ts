import type { Automation, AutomationCatalog, SchedulePreview } from '@poietica/contract/automation'
import type { AutomationDraft } from './automation'
import type { AutomationGateway } from './automation-gateway'

interface AutomationsViewModel {
  readonly automations: readonly Automation[]
  readonly revision: number | null
  readonly loaded: boolean
  readonly error: string | null
  readonly watchError: string | null
  readonly pending: readonly string[]
}

export interface AutomationStore {
  readonly getSnapshot: () => AutomationsViewModel
  readonly subscribe: (listener: () => void) => () => void
  readonly create: (draft: AutomationDraft) => Promise<boolean>
  readonly update: (
    id: string,
    revision: number,
    draft: AutomationDraft,
    enabled: boolean,
  ) => Promise<boolean>
  readonly remove: (id: string) => Promise<boolean>
  readonly setEnabled: (id: string, revision: number, enabled: boolean) => Promise<boolean>
  readonly runNow: (id: string) => Promise<boolean>
  readonly cancel: (runId: string) => Promise<boolean>
  readonly preview: (schedule: string | null, timeZone: string) => Promise<SchedulePreview>
  readonly refresh: () => Promise<boolean>
  readonly start: () => () => void
}

interface Options {
  readonly createId: () => string
  readonly report: (operation: string, cause: unknown) => void
}

// Command receipts and subscriptions are renderer-owned; executions never are.
export function createAutomationStore(
  gateway: AutomationGateway,
  options: Options,
): AutomationStore {
  let snapshot: AutomationsViewModel = {
    automations: [],
    revision: null,
    loaded: false,
    error: null,
    watchError: null,
    pending: [],
  }
  const listeners = new Set<() => void>()
  const commands = new Map<string, Promise<boolean>>()
  const runRequests = new Map<string, string>()
  let generation = 0
  let started = false
  let reading: Promise<boolean> | null = null

  function publish(patch: Partial<AutomationsViewModel>): void {
    snapshot = { ...snapshot, ...patch }
    for (const listener of listeners) {
      listener()
    }
  }

  function accept(catalog: AutomationCatalog): void {
    if (snapshot.revision !== null && catalog.revision <= snapshot.revision) {
      return
    }
    publish({ automations: catalog.automations, revision: catalog.revision, loaded: true })
  }

  function failure(operation: string, cause: unknown): string {
    options.report(operation, cause)
    const detail = cause instanceof Error ? cause.message : String(cause)
    return [operation, detail].join('：')
  }

  function command(
    key: string,
    operation: string,
    send: () => Promise<AutomationCatalog>,
  ): Promise<boolean> {
    const pending = commands.get(key)
    if (pending !== undefined) {
      return pending
    }
    const owner = generation
    publish({ error: null })
    const receipt = Promise.resolve()
      .then(send)
      .then(
        (catalog) => {
          if (owner === generation) {
            accept(catalog)
          }
          return true
        },
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

  function refresh(): Promise<boolean> {
    if (reading !== null) {
      return reading
    }
    const owner = generation
    const request = gateway
      .loadCatalog()
      .then(
        (catalog) => {
          if (owner === generation) {
            accept(catalog)
            publish({ error: null })
          }
          return true
        },
        (cause: unknown) => {
          if (owner === generation) {
            publish({ error: failure('自动化目录读取失败', cause) })
          }
          return false
        },
      )
      .finally(() => {
        if (reading === request) {
          reading = null
        }
      })
    reading = request
    return request
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    create: (draft) =>
      command('create', '创建失败', () =>
        gateway.create({ ...draft, sessionConfig: { ...draft.sessionConfig } }),
      ),
    update: (id, expectedRevision, draft, enabled) =>
      command(`update:${id}`, '保存失败，草稿未覆盖', () =>
        gateway.update({
          id,
          expectedRevision,
          creation: { ...draft, sessionConfig: { ...draft.sessionConfig } },
          enabled,
        }),
      ),
    remove: (id) => command(`remove:${id}`, '删除失败', () => gateway.remove(id)),
    setEnabled: (id, revision, enabled) =>
      command(`enable:${id}`, '修改计划状态失败', () => gateway.enable(id, revision, enabled)),
    runNow(id) {
      const requestId = runRequests.get(id) ?? options.createId()
      runRequests.set(id, requestId)
      return command(`run:${id}`, '运行请求未确认；重试将沿用同一请求身份', () =>
        gateway.run(id, requestId),
      ).then((accepted) => {
        if (accepted && runRequests.get(id) === requestId) {
          runRequests.delete(id)
        }
        return accepted
      })
    },
    cancel: (runId) => command(`cancel:${runId}`, '停止请求未确认', () => gateway.cancel(runId)),
    preview: gateway.preview,
    refresh,
    start() {
      if (started) {
        throw new Error('Automation catalog observation is already started')
      }
      started = true
      generation += 1
      reading = null
      const owner = generation
      let off: (() => void) | null = null
      let connecting = false

      async function attach(): Promise<void> {
        if (connecting || off !== null || generation !== owner) {
          return
        }
        connecting = true
        try {
          const release = await gateway.watchCatalog((catalog) => {
            if (generation === owner) {
              accept(catalog)
            }
          })
          if (generation !== owner) {
            release()
            return
          }
          off = release
          publish({ watchError: null })
        } catch (cause: unknown) {
          const message = failure('自动化更新订阅失败，正在通过读取核对', cause)
          if (generation === owner) {
            publish({ watchError: message })
          }
        } finally {
          connecting = false
          if (generation === owner) {
            await refresh()
          }
        }
      }

      void attach()
      // Read-only repair covers lost notifications; this timer cannot claim or submit work.
      const timer = setInterval(() => {
        void refresh()
        void attach()
      }, 15_000)
      return () => {
        if (generation !== owner) {
          return
        }
        generation += 1
        started = false
        reading = null
        clearInterval(timer)
        try {
          off?.()
        } catch (cause: unknown) {
          failure('自动化更新订阅未能释放', cause)
        }
        off = null
      }
    },
  }
}
