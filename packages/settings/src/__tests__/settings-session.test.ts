import { describe, expect, it } from 'bun:test'
import type { AppSettings } from '../settings'
import { createSettingsSession } from '../settings-session'
import type { SettingsStore } from '../settings-store'

const INITIAL: AppSettings = {
  theme: 'system',
  language: 'zh-CN',
  general: {
    sendWithModifier: false,
    confirmBeforeDelete: true,
    notifyOnCompletion: true,
    daemon: true,
  },
  appearance: {
    density: 'comfortable',
    reduceMotion: false,
    messageTimestamps: true,
  },
  modelPicker: { hiddenModelAliases: [], providerOrder: [] },
  privacy: {
    telemetry: false,
    crashReporting: true,
    updateCheck: true,
  },
}

function deferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => undefined

  let reject: (cause?: unknown) => void = () => undefined

  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })

  return {
    promise,
    resolve,
    reject,
  }
}

function manualScheduler() {
  let tasks: Array<{
    active: boolean
    run: () => void
  }> = []

  return {
    schedule(task: () => void) {
      const entry = {
        active: true,
        run: task,
      }

      tasks.push(entry)

      return () => {
        entry.active = false
      }
    },

    flush() {
      const ready = tasks

      tasks = []

      for (const task of ready) {
        if (task.active) {
          task.run()
        }
      }
    },
  }
}

const OBSERVABLE_STORE = {
  getSnapshot: () => undefined,
  subscribe: () => () => undefined,
}

async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('SettingsSession', () => {
  it('starts synchronously from an existing persisted snapshot', () => {
    let loads = 0
    const store: SettingsStore = {
      ...OBSERVABLE_STORE,
      getSnapshot: () => INITIAL,
      load: () => {
        loads += 1
        return Promise.resolve(INITIAL)
      },
      save: async () => undefined,
      reset: async () => INITIAL,
    }
    const session = createSettingsSession({
      store,
      schedule: manualScheduler().schedule,
    })

    session.start()

    expect(session.getSnapshot()).toMatchObject({ status: 'ready', settings: INITIAL })
    expect(loads).toBe(0)
  })

  it('accepts edits during a save and persists the newest draft', async () => {
    const loaded = deferred<AppSettings>()

    const saves: Array<{
      settings: AppSettings
      result: ReturnType<typeof deferred<void>>
    }> = []

    const scheduler = manualScheduler()

    const store: SettingsStore = {
      ...OBSERVABLE_STORE,
      load: () => loaded.promise,

      save: (settings) => {
        const result = deferred<void>()

        saves.push({
          settings,
          result,
        })

        return result.promise
      },

      reset: async () => INITIAL,
    }

    const session = createSettingsSession({
      store,
      schedule: scheduler.schedule,
    })

    const stop = session.start()

    loaded.resolve(INITIAL)

    await settle()

    session.update((settings) => ({
      ...settings,
      theme: 'dark',
    }))

    scheduler.flush()

    expect(saves).toHaveLength(1)
    expect(saves[0]?.settings.theme).toBe('dark')

    session.update((settings) => ({
      ...settings,
      language: 'en',
    }))

    expect(session.getSnapshot().settings?.language).toBe('en')

    expect(session.getSnapshot().status).toBe('saving')

    scheduler.flush()
    saves[0]?.result.resolve()

    await settle()

    expect(saves).toHaveLength(2)

    expect(saves[1]?.settings).toMatchObject({
      theme: 'dark',
      language: 'en',
    })

    saves[1]?.result.resolve()

    await settle()

    expect(session.getSnapshot()).toMatchObject({
      status: 'ready',
      settings: {
        theme: 'dark',
        language: 'en',
      },
    })

    stop()
  })

  it('waits for every dirty draft before closing', async () => {
    const saves: Array<ReturnType<typeof deferred<void>>> = []

    const scheduler = manualScheduler()

    const store: SettingsStore = {
      ...OBSERVABLE_STORE,
      load: async () => INITIAL,

      save: () => {
        const result = deferred<void>()

        saves.push(result)

        return result.promise
      },

      reset: async () => INITIAL,
    }

    const session = createSettingsSession({
      store,
      schedule: scheduler.schedule,
    })

    session.start()

    await settle()

    session.update((settings) => ({
      ...settings,
      theme: 'dark',
    }))

    session.requestClose()

    session.update((settings) => ({
      ...settings,
      language: 'en',
    }))

    expect(saves).toHaveLength(1)

    expect(session.getSnapshot().status).not.toBe('closed')

    saves[0]?.resolve()

    await settle()

    expect(saves).toHaveLength(2)

    expect(session.getSnapshot().status).not.toBe('closed')

    saves[1]?.resolve()

    await settle()

    expect(session.getSnapshot()).toEqual({
      status: 'closed',
    })
  })

  it('applies edits made during reset on top of the reset result', async () => {
    const resetResult = deferred<AppSettings>()

    const saves: AppSettings[] = []
    const scheduler = manualScheduler()

    const store: SettingsStore = {
      ...OBSERVABLE_STORE,
      load: async () => ({
        ...INITIAL,
        theme: 'dark',
      }),

      save: (settings) => {
        saves.push(settings)
        return Promise.resolve()
      },

      reset: () => resetResult.promise,
    }

    const session = createSettingsSession({
      store,
      schedule: scheduler.schedule,
    })

    session.start()

    await settle()

    session.reset()

    session.update((settings) => ({
      ...settings,
      language: 'en',
    }))

    scheduler.flush()
    resetResult.resolve(INITIAL)

    await settle()
    await settle()

    expect(saves).toHaveLength(1)

    expect(saves[0]).toMatchObject({
      theme: 'system',
      language: 'en',
    })
  })

  it('surfaces load failure and retries through the same port', async () => {
    let attempts = 0

    const store: SettingsStore = {
      ...OBSERVABLE_STORE,
      load: () => {
        attempts += 1

        if (attempts === 1) {
          return Promise.reject(new Error('disk unavailable'))
        }

        return Promise.resolve(INITIAL)
      },

      save: async () => undefined,
      reset: async () => INITIAL,
    }

    const session = createSettingsSession({
      store,
      schedule: manualScheduler().schedule,
    })

    session.start()

    await settle()

    expect(session.getSnapshot()).toMatchObject({
      status: 'error',
      operation: 'load',
      error: 'disk unavailable',
    })

    session.retry()

    await settle()

    expect(session.getSnapshot()).toMatchObject({
      status: 'ready',
      settings: INITIAL,
    })
  })
  it('turns a stalled load into a retryable error', () => {
    const scheduler = manualScheduler()
    const store: SettingsStore = {
      ...OBSERVABLE_STORE,
      load: () => new Promise<AppSettings>(() => undefined),
      save: async () => undefined,
      reset: async () => INITIAL,
    }
    const session = createSettingsSession({ store, schedule: scheduler.schedule })

    session.start()
    scheduler.flush()

    expect(session.getSnapshot()).toMatchObject({
      status: 'error',
      operation: 'load',
      error: '设置加载超时，请重试。',
    })
  })
})
