import { describe, expect, test } from 'bun:test'
import { type Clock, isAppError, noopLogger, toDisposable } from '@poietica/foundation'
import { updateErrors } from '../../contract/errors'
import { createUpdateService, notesToText, type UpdaterPort } from '../update-service'

/*
 * UP-1…UP-7（07 页 §15G）。测的是**状态机**，不是 electron-updater：端口注入之后，
 * 全部相位转换、失败回话、安装路径都在这里钉住。
 */

/** 本功能不需要 test-kit：状态机只读 clock.now()，一个定值时钟就够了（UP-2 断言这一格）。 */
const fixedClock: Clock = {
  now: () => 1_700_000_000_000,
  setTimeout: () => toDisposable(() => undefined),
  setInterval: () => toDisposable(() => undefined),
}

function service(updater: UpdaterPort | null, quit?: (finalize: () => void) => Promise<void>) {
  return createUpdateService({
    updater,
    currentVersion: '0.5.0',
    logger: noopLogger,
    clock: fixedClock,
    quit: quit ?? (() => Promise.resolve()),
  })
}

/** 默认端口：发现 1.2.3、下载立即成功；各项行为可逐字段覆盖。 */
function updater(over: Partial<UpdaterPort> = {}): UpdaterPort {
  return {
    checkForUpdates: () => Promise.resolve({ isUpdateAvailable: true, updateInfo: { version: '1.2.3' } }),
    downloadUpdate: () => Promise.resolve(),
    quitAndInstall: () => undefined,
    onDownloadProgress: () => () => undefined,
    ...over,
  }
}

async function expectAppError(run: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await run()
    throw new Error('应当抛错')
  } catch (e) {
    expect(isAppError(e) && e.code).toBe(code)
  }
}

describe('UP-1: 开发版（updater = null）', () => {
  test('相位固定为 disabled，check 抛 update.disabled', async () => {
    const s = service(null)
    expect(s.state().phase).toBe('disabled')
    expect(s.state().currentVersion).toBe('0.5.0')
    await expectAppError(() => s.check(), updateErrors.disabled)
  })
})

describe('UP-2: 没有新版本', () => {
  test('phase 回到 idle 并且 lastCheckedAt 已设置', async () => {
    const s = service(
      updater({
        checkForUpdates: () => Promise.resolve({ isUpdateAvailable: false, updateInfo: { version: '0.5.0' } }),
      }),
    )
    const next = await s.check()
    expect(next.phase).toBe('idle')
    expect(next.version).toBeNull()
    expect(next.lastCheckedAt).toBe(1_700_000_000_000)
  })

  test('null（更新器被停用）与 false 是同一句话', async () => {
    const s = service(updater({ checkForUpdates: () => Promise.resolve(null) }))
    const next = await s.check()
    expect(next.phase).toBe('idle')
    expect(next.lastCheckedAt).not.toBeNull()
  })
})

describe('UP-3: 有新版本 → 下载（进度 50）→ 完成', () => {
  test('available → downloading(0.5) → ready，且进度订阅在下载结束时退订', async () => {
    let report: ((percent: number) => void) | null = null
    let subscribed = 0
    let unsubscribed = 0
    const s = service(
      updater({
        onDownloadProgress: (handler) => {
          subscribed += 1
          report = handler
          return () => {
            unsubscribed += 1
          }
        },
        downloadUpdate: () => {
          report?.(50)
          return Promise.resolve()
        },
      }),
    )

    const available = await s.check()
    expect(available.phase).toBe('available')
    expect(available.version).toBe('1.2.3')
    expect(available.notes).toBeNull()

    await s.download()
    expect(s.state().phase).toBe('ready')
    expect(s.state().progress).toBe(1)
    expect(subscribed).toBe(1)
    expect(unsubscribed).toBe(1)
  })

  test('下载中的相位与 0.5 进度当场可见', async () => {
    // 放在盒子里而不是裸 let：闭包里的赋值能让 tsc 的控制流分析放过属性收窄。
    const sink: { report: ((percent: number) => void) | null } = { report: null }
    const gate: { release: (() => void) | null } = { release: null }
    const s = service(
      updater({
        onDownloadProgress: (handler) => {
          sink.report = handler
          return () => undefined
        },
        downloadUpdate: () => new Promise<void>((resolve) => (gate.release = () => resolve())),
      }),
    )
    await s.check()
    const running = s.download()

    expect(s.state().phase).toBe('downloading')
    expect(s.state().progress).toBe(0)
    sink.report?.(50)
    expect(s.state().progress).toBe(0.5)
    gate.release?.()
    await running
    expect(s.state().phase).toBe('ready')
  })

  test('发布说明里的 HTML 被 notesToText 变成纯文本', async () => {
    const s = service(
      updater({
        checkForUpdates: () =>
          Promise.resolve({
            isUpdateAvailable: true,
            updateInfo: { version: '1.2.3', releaseNotes: '<p>修好了</p><ul><li>甲</li></ul>' },
          }),
      }),
    )
    const next = await s.check()
    expect(next.notes).toBe('修好了\n甲')
  })
})

describe('UP-4: idle 时 download', () => {
  test('抛 update.invalid_phase', async () => {
    await expectAppError(() => service(updater()).download(), updateErrors.invalid_phase)
  })
})

describe('UP-5: install', () => {
  test('调用 quit，传入的 finalize 执行后调用 quitAndInstall', async () => {
    const calls: string[] = []
    let captured: (() => void) | null = null
    const s = service(
      updater({
        quitAndInstall: () => {
          calls.push('quitAndInstall')
        },
      }),
      (finalize) => {
        calls.push('quit')
        captured = finalize
        return Promise.resolve()
      },
    )
    await s.check()
    await s.download()

    await s.install()
    expect(calls).toEqual(['quit'])
    const finalize = captured as unknown as (() => void) | null
    expect(finalize).not.toBeNull()
    finalize?.()
    expect(calls).toEqual(['quit', 'quitAndInstall'])
  })

  test('未就绪时 install 抛 update.invalid_phase', async () => {
    await expectAppError(() => service(updater()).install(), updateErrors.invalid_phase)
  })
})

describe('UP-6: notesToText', () => {
  test("'<p>a</p><ul><li>b</li></ul>' → 'a\\nb'", () => {
    expect(notesToText('<p>a</p><ul><li>b</li></ul>')).toBe('a\nb')
  })

  test('空输入与纯标签交回 null', () => {
    expect(notesToText(undefined)).toBeNull()
    expect(notesToText('')).toBeNull()
    expect(notesToText('<div></div>')).toBeNull()
    expect(notesToText([])).toBeNull()
  })

  test('逐版本数组（electron-updater 的另一种形状）：每条自带的块尾换行 + 数组连接换行', () => {
    /* 07 页 §15D 的 notesToText 是逐字实现：map 出的每条保留自己的块尾 \n，join('\n') 再接一次。 */
    expect(notesToText([{ version: '1.2.3', note: '<p>甲</p>' }, { note: '<p>乙</p>' }])).toBe('甲\n\n乙')
  })

  test('<br> 换行且连续空行收成一段', () => {
    expect(notesToText('a<br>b<br/><br><br>c')).toBe('a\nb\n\nc')
  })
})

describe('UP-7: 检查抛错', () => {
  test('相位变 error 且 error 是给用户看的中文', async () => {
    const s = service(updater({ checkForUpdates: () => Promise.reject(new Error('offline')) }))
    const next = await s.check()
    expect(next.phase).toBe('error')
    expect(next.error).toBe('检查更新失败，请稍后重试')
    expect(next.lastCheckedAt).toBeNull()
  })

  test('下载失败也给中文文案，并退回可重试的 error 相位', async () => {
    const s = service(updater({ downloadUpdate: () => Promise.reject(new Error('disk full')) }))
    await s.check()
    const next = await s.download()
    expect(next.phase).toBe('error')
    expect(next.error).toBe('下载更新失败，请稍后重试')
    expect(next.progress).toBeNull()
  })
})

describe('重复检查保护', () => {
  test('ready 相位再 check 直接返回当前状态，不再问更新器', async () => {
    let checks = 0
    const s = service(
      updater({
        checkForUpdates: () => {
          checks += 1
          return Promise.resolve({ isUpdateAvailable: true, updateInfo: { version: '1.2.3' } })
        },
      }),
    )
    await s.check()
    await s.download()
    const next = await s.check()
    expect(next.phase).toBe('ready')
    expect(checks).toBe(1)
  })
})
