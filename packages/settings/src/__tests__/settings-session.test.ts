import { describe, expect, it } from 'bun:test'
import { type AppSettings, DEFAULT_APP_SETTINGS } from '../settings'
import { createSettingsSession } from '../settings-session'
import type { SettingsStore } from '../settings-store'

/*
 * 起点从默认值铺开，只钉住用例真正断言到的那两格。
 *
 * 原来这里是一份手抄的字面量，于是 AppSettings 一改它就烂：shortcuts 那张表早已删掉
 * （settings.ts 写着理由 —— 全仓没有读取点，快捷键的真相在命令注册表里），这份抄本还
 * 留着它；而后来加的 general 与 appearance 它一个都没有。展开默认值之后这类漂移不会
 * 再发生 —— 那个常量的类型就是 AppSettings，它不可能缺字段。
 *
 * theme 是被断言的：reset 落地之后那一次保存要看见 'system'。language 只需要与用例里
 * 改成的 'en' 不同，钉住它是为了把起点写在纸面上，而不是藏进默认值里。
 */
const INITIAL: AppSettings = {
  ...DEFAULT_APP_SETTINGS,
  theme: 'system',
  language: 'zh-CN',
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

async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('SettingsSession', () => {
  it('accepts edits during a save and persists the newest draft', async () => {
    const loaded = deferred<AppSettings>()

    const saves: Array<{
      settings: AppSettings
      result: ReturnType<typeof deferred<void>>
    }> = []

    const scheduler = manualScheduler()

    const store: SettingsStore = {
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
})
