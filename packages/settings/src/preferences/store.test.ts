import { expect, test } from 'bun:test'
import type { AppSettings, Problem, SettingsWriteResult } from '@poietica/contract/settings'
import { createSettingsSession } from './session'
import { createSettingsStore, type SettingsPersistence } from './store'

function settings(theme: AppSettings['theme'] = 'system'): AppSettings {
  return {
    theme,
    language: 'zh-CN',
    general: {
      sendWithModifier: false,
      confirmBeforeDelete: true,
      notifyOnCompletion: true,
      daemon: true,
    },
    appearance: { density: 'comfortable', reduceMotion: false, messageTimestamps: true },
    modelPicker: { hiddenModelAliases: [], providerOrder: [] },
    privacy: { telemetry: false, crashReporting: true, updateCheck: true },
  }
}
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
const receipt = (value: AppSettings): SettingsWriteResult => ({
  settings: value,
  applicationProblem: null,
})
function persistence(overrides: Partial<SettingsPersistence> = {}): SettingsPersistence {
  return {
    read: async () => settings(),
    save: async (value) => receipt(value),
    reset: async () => receipt(settings()),
    ...overrides,
  }
}
function create(port = persistence()) {
  const problems: Problem[] = []
  const store = createSettingsStore({
    persistence: port,
    onApplicationProblem: (problem) => problems.push(problem),
  })
  return { store, problems }
}
test('reads coalesce and the confirmed snapshot stays stable', async () => {
  const pending = deferred<AppSettings>()
  let reads = 0
  const { store } = create(
    persistence({
      read: () => {
        reads += 1
        return pending.promise
      },
    }),
  )
  const first = store.load()
  expect(store.load()).toBe(first)
  pending.resolve(settings())
  const snapshot = await first
  expect(await store.load()).toBe(snapshot)
  expect(store.getSnapshot()).toBe(snapshot)
  expect(reads).toBe(1)
})
test('save and reset share one queue and submitted input is isolated', async () => {
  const started = deferred<void>()
  const saved = deferred<SettingsWriteResult>()
  const calls: string[] = []
  let submitted: AppSettings | undefined
  const { store } = create(
    persistence({
      save: (value) => {
        calls.push('save')
        submitted = value
        started.resolve(undefined)
        return saved.promise
      },
      reset: async () => {
        calls.push('reset')
        return receipt(settings())
      },
    }),
  )
  const draft = settings('dark')
  const saving = store.save(draft)
  const resetting = store.reset()
  draft.language = 'changed-after-submission'
  await started.promise
  expect(calls).toEqual(['save'])
  expect(submitted?.language).toBe('zh-CN')
  saved.resolve(receipt(settings('dark')))
  await saving
  await resetting
  expect(calls).toEqual(['save', 'reset'])
  expect(store.getSnapshot()?.theme).toBe('system')
})
test('a failed write neither poisons the queue nor changes the confirmed snapshot', async () => {
  const { store } = create(
    persistence({
      save: async () => {
        throw new Error('disk failed')
      },
    }),
  )
  const confirmed = await store.load()
  await expect(store.save(settings('dark'))).rejects.toThrow('disk failed')
  expect(store.getSnapshot()).toBe(confirmed)
  expect((await store.reset()).theme).toBe('system')
})
test('a late read cannot overwrite a later committed write', async () => {
  const reading = deferred<AppSettings>()
  const started = deferred<void>()
  const { store } = create(
    persistence({
      read: () => {
        started.resolve(undefined)
        return reading.promise
      },
    }),
  )
  const pending = store.load()
  await started.promise
  await store.save(settings('dark'))
  reading.resolve(settings('light'))
  expect((await pending).theme).toBe('dark')
  expect(store.getSnapshot()?.theme).toBe('dark')
})
test('application failure reports a problem but retains the successful commit', async () => {
  const problem: Problem = {
    code: 'agentRejected',
    category: 'protocol',
    retryability: 'no',
    userMessageKey: 'problem.agentRejected',
    diagnosticId: '00000000-0000-4000-8000-000000000001',
    details: {},
  }
  const { store, problems } = create(
    persistence({ save: async (value) => ({ settings: value, applicationProblem: problem }) }),
  )
  await store.save(settings('dark'))
  expect(store.getSnapshot()?.theme).toBe('dark')
  expect(problems).toEqual([problem])
})
test('dispose rejects new work, drains accepted writes, and stops notifications', async () => {
  const pending = deferred<SettingsWriteResult>()
  const { store } = create(persistence({ save: () => pending.promise }))
  let notifications = 0
  store.subscribe(() => {
    notifications += 1
  })
  const saving = store.save(settings('dark'))
  const closing = store.dispose()
  await expect(store.save(settings())).rejects.toThrow('disposed')
  pending.resolve(receipt(settings('dark')))
  await saving
  await closing
  expect(notifications).toBe(0)
})
test('session retry supersedes a stalled read rather than reusing it', async () => {
  const first = deferred<AppSettings>()
  const second = deferred<AppSettings>()
  const tasks = new Set<() => void>()
  let reads = 0
  const { store } = create(
    persistence({ read: () => (++reads === 1 ? first.promise : second.promise) }),
  )
  const session = createSettingsSession({
    store,
    schedule: (task) => {
      tasks.add(task)
      return () => {
        tasks.delete(task)
      }
    },
  })
  const stop = session.start()
  const initial = store.load()
  await Promise.resolve()
  for (const task of [...tasks]) {
    tasks.delete(task)
    task()
  }
  expect(session.getSnapshot().status).toBe('error')
  session.retry()
  const retried = store.load()
  expect(retried).not.toBe(initial)
  second.resolve(settings('dark'))
  await retried
  expect(session.getSnapshot().settings?.theme).toBe('dark')
  first.resolve(settings('light'))
  await initial
  expect(session.getSnapshot().settings?.theme).toBe('dark')
  expect(reads).toBe(2)
  stop()
  await store.dispose()
})
