import { describe, expect, test } from 'bun:test'

import {
  autoUpdaterOf,
  createUpdateCommands,
  createUpdateController,
  progressOf,
  type UpdaterEventSource,
  type UpdaterPort,
} from './update'

/*
 * 这三条命令是渲染层更新横幅的全部后端。测的是**相位**：发现哪一版、下载哪一版、
 * 装的是不是那一版 —— 版本号对不上还照下，就是把别人的安装包装到这台机器上。
 */

/* 照抄 electron-updater 的答复形状：null 是更新器停用，false 才是「已是最新」。 */
type Found = { version: string; releaseNotes?: unknown } | null

interface Harness {
  readonly controller: ReturnType<typeof createUpdateController>
  readonly calls: string[]
  /** 换掉下一轮检查的答复：发布换版本时渲染层就是这么再问一次的。 */
  readonly answers: { found: Found; available: boolean }
  /** 主进程在这一头收进度；下载中途推一帧就写进它。 */
  readonly progress: number[]
  readonly pushProgress: (payload: unknown) => void
}

function harness(found: Found, available = found !== null): Harness {
  const calls: string[] = []
  const answers = { found, available }
  const progress: number[] = []
  const listeners: ((payload: unknown) => void)[] = []

  const updater: UpdaterPort = {
    checkForUpdates: () => {
      calls.push('check')

      return Promise.resolve(
        answers.found === null
          ? null
          : { isUpdateAvailable: answers.available, updateInfo: answers.found },
      )
    },
    downloadUpdate: () => {
      calls.push('download')

      return Promise.resolve([])
    },
    quitAndInstall: () => {
      calls.push('install')
    },
    onDownloadProgress: (handler) => {
      const listener = (payload: unknown): void => {
        const shaped = progressOf(payload)

        if (shaped !== null) {
          handler(shaped)
        }
      }

      listeners.push(listener)

      return () => {
        listeners.splice(listeners.indexOf(listener), 1)
      }
    },
  }

  return {
    controller: createUpdateController(updater, (value) => {
      progress.push(value.percent)
    }),
    calls,
    answers,
    progress,
    pushProgress: (payload) => {
      for (const listener of listeners) {
        listener(payload)
      }
    },
  }
}

describe('更新的相位', () => {
  test('发现新版本：报出版本与发布说明，装的是同一版', async () => {
    const h = harness({ version: '1.2.3', releaseNotes: '修好了更新' })

    expect(await h.controller.check()).toEqual({ version: '1.2.3', notes: '修好了更新' })

    await h.controller.download('1.2.3')
    h.controller.relaunch()

    expect(h.calls).toEqual(['check', 'download', 'install'])
  })

  test('发布说明是逐版本数组时如实缺席，不编一个字符串', async () => {
    const h = harness({ version: '1.2.3', releaseNotes: [{ version: '1.2.3', note: 'x' }] })

    expect(await h.controller.check()).toEqual({ version: '1.2.3', notes: null })
  })

  test('更新器停用（null）：check 回 null，下载与安装都无从谈起', async () => {
    const h = harness(null)

    expect(await h.controller.check()).toBeNull()
    await expect(h.controller.download('1.2.3')).rejects.toThrow('选中的更新已经不在手上了')
    expect(() => h.controller.relaunch()).toThrow('没有已下载的更新可安装')
  })

  /*
   * electron-updater 在「已是最新」时回的**不是 null**，而是一份 isUpdateAvailable: false
   * 的结果，版本号是清单里那一版。把它当新版本报出去，界面就会去下一份根本没被记下的
   * 更新 —— downloadUpdate 当场抛「Please check update first」。这条是实机探针抓到的。
   */
  test('已是最新（isUpdateAvailable: false）：不许当成有新版本报出去', async () => {
    const h = harness({ version: '1.2.3' }, false)

    expect(await h.controller.check()).toBeNull()
    expect(h.calls).toEqual(['check'])
  })

  test('下载的版本不是刚发现的那一版：拒绝，且不碰下载', async () => {
    const h = harness({ version: '1.2.3' })

    await h.controller.check()

    await expect(h.controller.download('9.9.9')).rejects.toThrow('选中的更新已经不在手上了')
    expect(h.calls).toEqual(['check'])
  })

  test('发布换了版本：上一版不能再下载，新的那一版可以', async () => {
    const h = harness({ version: '1.2.3' })

    await h.controller.check()

    h.answers.found = { version: '1.3.0' }
    await h.controller.check()

    await expect(h.controller.download('1.2.3')).rejects.toThrow('选中的更新已经不在手上了')
    await h.controller.download('1.3.0')

    expect(h.calls).toEqual(['check', 'check', 'download'])
  })
})

/*
 * 进度是这一段唯一的活口：不订阅就永远没有中间值，订阅不收干净就会在第二次下载里
 * 报两遍。所以钉的是「订阅活在下载里」与「载荷校验」两件事。
 */
describe('下载进度', () => {
  test('下载期间报出来的进度落到报告函数上', async () => {
    const h = harness({ version: '1.2.3' })

    await h.controller.check()
    await h.controller.download('1.2.3')

    /* downloadUpdate 已经返回，订阅也该摘掉了：此时再推一帧没人听。 */
    h.pushProgress({ percent: 42 })
    expect(h.progress).toEqual([])
  })

  test('订阅只活在下载里：收工时摘干净，不留第二个听众', async () => {
    const h = harness({ version: '1.2.3' })
    const during: number[] = []

    /* 在下载途中推一帧：那时订阅还活着。 */
    const original = h.controller.download
    await h.controller.check()

    const download = original('1.2.3').then(() => {
      during.push(...h.progress)
    })

    h.pushProgress({ percent: 10 })
    await download

    expect(during).toEqual([10])

    /* 第一次下载收工后，第二轮的推送不该再有人收。 */
    await h.controller.download('1.2.3')
    h.pushProgress({ percent: 99 })
    expect(h.progress).toEqual([10])
  })

  /*
   * 载荷来自跨库边界，是不可信输入。percent 不是 0-100 的数就不报 —— 界面上宁可
   * 停在「进度未知」，也不画一个从别人字节里读出来的数字。
   */
  test('载荷校验：只有 0-100 的有限数才算进度', () => {
    expect(progressOf({ percent: 0 })).toEqual({ percent: 0 })
    expect(progressOf({ percent: 100 })).toEqual({ percent: 100 })
    expect(progressOf({ percent: 42.5 })).toEqual({ percent: 42.5 })

    expect(progressOf({ percent: 101 })).toBeNull()
    expect(progressOf({ percent: -1 })).toBeNull()
    expect(progressOf({ percent: Number.NaN })).toBeNull()
    expect(progressOf({ percent: Number.POSITIVE_INFINITY })).toBeNull()
    expect(progressOf({ percent: '42' })).toBeNull()
    expect(progressOf({ percent: null })).toBeNull()
    expect(progressOf({})).toBeNull()
    expect(progressOf(null)).toBeNull()
    expect(progressOf('42')).toBeNull()
  })
})

describe('命令面', () => {
  const commands = (loads: { count: number }) =>
    createUpdateCommands(
      () => {
        loads.count += 1

        return Promise.resolve({
          checkForUpdates: () =>
            Promise.resolve({ isUpdateAvailable: true, updateInfo: { version: '2.0.0' } }),
          downloadUpdate: () => Promise.resolve([]),
          quitAndInstall: () => undefined,
          onDownloadProgress: () => () => undefined,
        })
      },
      () => undefined,
    )

  test('只认这三条，别的命令交回主进程', () => {
    const c = commands({ count: 0 })

    expect(c.handles('update_check')).toBe(true)
    expect(c.handles('update_download')).toBe(true)
    expect(c.handles('update_relaunch')).toBe(true)
    expect(c.handles('agent_threads')).toBe(false)
    expect(c.handles(undefined)).toBe(false)
  })

  test('三条命令共用一份相位，装载只发生一次', async () => {
    const loads = { count: 0 }
    const c = commands(loads)

    expect(await c.run('update_check', null)).toEqual({ version: '2.0.0', notes: null })
    await c.run('update_download', { version: '2.0.0' })
    await c.run('update_relaunch', null)

    expect(loads.count).toBe(1)
  })

  test('下载不说明版本是请求无效，不落到装载上', async () => {
    const loads = { count: 0 }
    const c = commands(loads)

    await expect(c.run('update_download', {})).rejects.toThrow('下载更新要说明是哪一个版本')
    expect(loads.count).toBe(0)
  })
})

/*
 * 动态 import 一个 CJS 包时，getter 导出只在 default 上。解构命名空间拿到的
 * autoUpdater 是 undefined，报出来正是线上那句
 * 「Cannot read properties of undefined (reading 'checkForUpdates')」。
 */
describe('装载 electron-updater', () => {
  const updater: UpdaterEventSource = {
    checkForUpdates: () => Promise.resolve(null),
    downloadUpdate: () => Promise.resolve([]),
    quitAndInstall: () => undefined,
    on: () => undefined,
    off: () => undefined,
  }

  test('命名导出在就取命名导出', () => {
    expect(autoUpdaterOf({ autoUpdater: updater })).toBe(updater)
  })

  test('只有 default 在（CJS 的 getter）就取 default 上的', () => {
    expect(autoUpdaterOf({ default: { autoUpdater: updater } })).toBe(updater)
  })

  test('两边都没有就早炸，不把 undefined 递给调用点', () => {
    expect(() => autoUpdaterOf({ default: {} })).toThrow('没有交出 autoUpdater')
    expect(() => autoUpdaterOf(undefined)).toThrow('没有交出 autoUpdater')
  })
})
