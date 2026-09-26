import { describe, expect, it } from 'bun:test'
import type { AgentSettingEntry, AgentSettingsCatalog, AgentSettingsPort } from './model'
import { AgentSettingsStore } from './store'

/*
 * 目录的持有者这一层的判据。
 *
 * 核心那一条：**写只有一个写点，且写完拿 agent 交回的那份目录换掉快照**。
 * 不乐观改写本地状态 —— 改没改由 agent 说，写的是它自己的盘。所以下面反复断言
 * 「屏幕上此刻的值 == 端口最后交回的那一份」，而不是「我们以为改成什么了」。
 */

function entry(path: string, value: unknown): AgentSettingEntry {
  return {
    path,
    type: 'boolean',
    label: path,
    description: '',
    tab: 'tools',
    default: false,
    value,
    secret: false,
    hasValue: false,
  }
}

function catalog(settings: readonly AgentSettingEntry[]): AgentSettingsCatalog {
  return { tabs: ['tools'], settings }
}

function bench(initial: AgentSettingsCatalog) {
  const writes: { path: string; value: unknown }[] = []
  const port: AgentSettingsPort = {
    read: () => Promise.resolve(initial),
    write: (path, value) => {
      writes.push({ path, value })
      return Promise.resolve([])
    },
  }

  return { port, writes, store: new AgentSettingsStore(port) }
}

describe('AgentSettingsStore', () => {
  it('读一次就够：同一份目录不重复问 agent', async () => {
    let calls = 0
    const store = new AgentSettingsStore({
      read: () => {
        calls += 1
        return Promise.resolve(catalog([entry('browser.headless', false)]))
      },
      write: () => Promise.resolve([]),
    })

    await Promise.all([store.load(), store.load()])
    await store.load()

    expect(calls).toBe(1)
    store.dispose()
  })

  /** 写经端口出去：路径与值原样，不折算、不预筛（预筛就是第二份路径表）。 */
  it('写把路径与值原样交给端口', async () => {
    const { store, writes } = bench(catalog([entry('browser.headless', false)]))

    await store.load()
    await store.write('compaction.thresholdPercent', 75)

    expect(writes).toEqual([{ path: 'compaction.thresholdPercent', value: 75 }])
    store.dispose()
  })

  /**
   * **写完以 agent 交回的那一份为准，不做乐观改写。**
   *
   * 端口故意「反着答」：我们写 true，它交回 false。屏幕上必须是 false —— 那才是那头的事实。
   */
  it('写完之后屏幕上是 agent 交回的值，不是我们请求写的值', async () => {
    const { store } = bench(catalog([entry('browser.headless', false)]))

    await store.load()

    const store2 = new AgentSettingsStore({
      read: () => Promise.resolve(catalog([entry('browser.headless', false)])),
      /* 请求写 true，agent 那头报回来还是 false（比如它自己拒绝了这个值）。 */
      write: () => Promise.resolve([entry('browser.headless', false)]),
    })

    await store2.load()
    await store2.write('browser.headless', true)

    expect(store2.getSnapshot().catalog?.settings[0]?.value).toBe(false)
    expect(store.getSnapshot().catalog?.settings[0]?.value).toBe(false)

    store.dispose()
    store2.dispose()
  })

  it('写完之后栏位表照旧：一次写入不改导航', async () => {
    const { store } = bench(catalog([entry('browser.headless', false)]))

    await store.load()

    const after = new AgentSettingsStore({
      read: () => Promise.resolve(catalog([entry('browser.headless', false)])),
      write: () => Promise.resolve([entry('browser.enabled', true)]),
    })

    await after.load()
    await after.write('browser.enabled', true)

    expect(after.getSnapshot().catalog?.tabs).toEqual(['tools'])
    expect(after.getSnapshot().catalog?.settings[0]?.path).toBe('browser.enabled')

    store.dispose()
    after.dispose()
  })

  it('写失败时留下错误，且不把那一次改动留在快照里', async () => {
    const store = new AgentSettingsStore({
      read: () => Promise.resolve(catalog([entry('browser.headless', false)])),
      write: () => Promise.reject(new Error('agent refused the value')),
    })

    await store.load()

    await expect(store.write('browser.headless', true)).rejects.toThrow('agent refused the value')

    const snapshot = store.getSnapshot()

    expect(snapshot.error).toBe('agent refused the value')
    expect(snapshot.saving).toBeNull()
    /* 快照还是读回来那一份：agent 没改，屏幕就不许改。 */
    expect(snapshot.catalog?.settings[0]?.value).toBe(false)

    store.dispose()
  })

  it('写的时候报出正在写哪一格', async () => {
    const gate = Promise.withResolvers<readonly AgentSettingEntry[]>()
    const store = new AgentSettingsStore({
      read: () => Promise.resolve(catalog([entry('browser.headless', false)])),
      write: () => gate.promise,
    })

    await store.load()

    const pending = store.write('browser.headless', true)

    expect(store.getSnapshot().saving).toBe('browser.headless')

    gate.resolve([entry('browser.headless', true)])
    await pending

    expect(store.getSnapshot().saving).toBeNull()
    store.dispose()
  })

  it('读失败留下错误，重试能救回来', async () => {
    let fail = true
    const store = new AgentSettingsStore({
      read: () =>
        fail
          ? Promise.reject(new Error('no live session'))
          : Promise.resolve(catalog([entry('browser.headless', false)])),
      write: () => Promise.resolve([]),
    })

    await store.load()

    expect(store.getSnapshot().catalog).toBeNull()
    expect(store.getSnapshot().error).toBe('no live session')

    fail = false
    await store.refresh()

    expect(store.getSnapshot().error).toBeNull()
    expect(store.getSnapshot().catalog?.settings).toHaveLength(1)

    store.dispose()
  })

  it('订阅在快照换掉时收到通知，dispose 之后不再收', async () => {
    const { store } = bench(catalog([entry('browser.headless', false)]))
    let notified = 0
    const stop = store.subscribe(() => {
      notified += 1
    })

    await store.load()
    expect(notified).toBeGreaterThan(0)

    stop()
    const before = notified
    await store.refresh()
    expect(notified).toBe(before)

    store.dispose()
  })
})
