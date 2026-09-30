import { describe, expect, it } from 'bun:test'
import {
  type AppUpdateController,
  type AppUpdateState,
  AppUpdateStore,
  type UpdateRelease,
} from './app-update-store'

/*
 * 「发现新版本就自动下载」是这个 store 的全部要点，也是这里唯一会静默退化的行为：
 * 一旦退回「发现后停在 available 等人点」，屏幕上仍然是「有新版本」，只是永远不下载。
 * 所以钉的是**动作序列**，不是状态名字。
 */

interface Harness {
  readonly store: AppUpdateStore
  readonly calls: string[]
  /** 让 check() 的答复落地。 */
  readonly settle: () => Promise<void>
  readonly state: () => AppUpdateState
}

function harness(release: UpdateRelease | null): Harness {
  const calls: string[] = []
  const answer: Promise<UpdateRelease | null> = Promise.resolve(release)

  const controller: AppUpdateController = {
    check: () => answer,
    download: (version, onProgress) => {
      calls.push(`download:${version}`)
      onProgress({ percent: 50 })
      return Promise.resolve()
    },
    relaunch: () => {
      calls.push('relaunch')
      return Promise.resolve()
    },
    dispose: () => Promise.resolve(),
  }

  const store = new AppUpdateStore(
    controller,
    () => Promise.resolve(true),
    (operation) => {
      calls.push(`fail:${operation}`)
    },
  )

  return {
    store,
    calls,
    settle: async () => {
      await answer
      /* 一次微任务不够：check 的 then 之后还接着 download 的 then。 */
      await Promise.resolve()
      await Promise.resolve()
    },
    state: store.getSnapshot,
  }
}

describe('发现新版本就自动下载', () => {
  it('手动检查拿到新版本后直接下载，不等人点', async () => {
    const h = harness({ version: '1.2.3', notes: null })

    h.store.check()
    await h.settle()

    expect(h.calls).toEqual(['download:1.2.3'])
    /* 下好就停在 ready：这一步才是要人按的。 */
    expect(h.state().phase).toBe('ready')
  })

  it('没有新版本时只回一句「已是最新」，绝不下载', async () => {
    const h = harness(null)

    h.store.check()
    await h.settle()

    expect(h.calls).toEqual([])
    expect(h.state().phase).toBe('latest')
  })

  it('重启是唯一的按钮：relaunch 只在 ready 上生效', async () => {
    const h = harness({ version: '1.2.3', notes: null })

    /* 还没下好就点重启：什么都不该发生（没有可装的东西）。 */
    h.store.relaunch()
    expect(h.calls).toEqual([])

    h.store.check()
    await h.settle()

    h.store.relaunch()
    expect(h.calls).toEqual(['download:1.2.3', 'relaunch'])
  })

  it('下载失败退回 idle，不留一个卡住的相位', async () => {
    const calls: string[] = []
    const store = new AppUpdateStore(
      {
        check: () => Promise.resolve({ version: '1.2.3', notes: null }),
        download: () => {
          calls.push('download')
          return Promise.reject(new Error('offline'))
        },
        relaunch: () => Promise.resolve(),
        dispose: () => Promise.resolve(),
      },
      () => Promise.resolve(true),
      (operation) => {
        calls.push(`fail:${operation}`)
      },
    )

    store.check()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(calls).toEqual(['download', 'fail:download-update'])
    /* 下一轮检查会重新发现并再下一遍，而不是停在一个点不动的相位上。 */
    expect(store.getSnapshot().phase).toBe('idle')
  })
})
