import type { SettingsStore } from '@poietica/settings'
import type { AppUpdateController } from './app-update'

/* 检查节奏只有这一份：定时器跟着 store 活，六小时才真的是六小时。 */
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000

/* 启动后不立刻检查：首屏还在装配，一个网络往返没有理由和它抢。 */
const FIRST_CHECK_DELAY_MS = 30_000

export type AppUpdateState =
  | { readonly phase: 'idle' }
  | { readonly phase: 'available'; readonly version: string }
  | {
      readonly phase: 'downloading'
      readonly version: string
      readonly percent: number | null
    }
  | { readonly phase: 'ready'; readonly version: string }

const IDLE: AppUpdateState = { phase: 'idle' }

/**
 * 更新这件事，一个进程一份。
 *
 * 一个下载任务的寿命是进程，不是某个插槽在当前布局下的可见性。形制与 ThreadsStore
 * / workspaceLayoutStore 一致：不可变快照、subscribe、引用没变就不通知；界面是只读
 * 投影，卸载重挂一个字都不丢。
 *
 * 相位就是唯一的闸：这里没有第二个"正在下载"的布尔量，原生侧的暂存态是同一件事的另
 * 一端，两边由版本号对齐。
 */
export class AppUpdateStore {
  readonly #controller: AppUpdateController

  readonly #settings: SettingsStore

  readonly #onFailure: (operation: string, cause: unknown) => void

  #state: AppUpdateState = IDLE

  #listeners = new Set<() => void>()

  constructor(
    controller: AppUpdateController,
    settings: SettingsStore,
    onFailure: (operation: string, cause: unknown) => void,
  ) {
    this.#controller = controller
    this.#settings = settings
    this.#onFailure = onFailure
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)

    return () => {
      this.#listeners.delete(listener)
    }
  }

  getSnapshot = (): AppUpdateState => this.#state

  /**
   * 开始按节奏检查，交回停下来的办法。
   *
   * 订阅与退订成对交给调用方的 effect：装载几次就订阅几次、退订几次，开发模式下的
   * 双次装载不会把它弄哑。要不要检查是调用方的决定，这里无条件执行。
   */
  start = (): (() => void) => {
    let active = true

    const check = async (): Promise<void> => {
      const phase = this.#state.phase

      /*
       * 下载中与已下好这两个相位钉着一个具体版本，问了也不能动它。available 必须继
       * 续问：否则提示过一次就再也不刷新，发布换了版本这枚胶囊会一直指着旧的那个。
       */
      if (!active || phase === 'downloading' || phase === 'ready') {
        return
      }

      const permitted = await this.#settings
        .load()
        .then((loaded) => loaded.privacy.updateCheck)
        .catch(() => false)

      if (!permitted || !active) {
        return
      }

      /*
       * 后台检查失败保持安静：离线是常态，为它报一次失败只是噪音。下载失败不同，
       * 那是人按下按钮之后的事，必须回话。
       */
      const release = await this.#controller.check().catch(() => null)

      if (!active || release === null) {
        return
      }

      this.#commit({ phase: 'available', version: release.version })
    }

    const first = window.setTimeout(() => {
      void check()
    }, FIRST_CHECK_DELAY_MS)

    const repeat = window.setInterval(() => {
      void check()
    }, CHECK_EVERY_MS)

    return () => {
      active = false
      window.clearTimeout(first)
      window.clearInterval(repeat)
    }
  }

  /** 开始下载。相位本身就是那道闸：只有 available 能起步。 */
  download = (): void => {
    const current = this.#state

    if (current.phase !== 'available') {
      return
    }

    const version = current.version

    this.#commit({ phase: 'downloading', version, percent: null })

    void this.#controller
      .download(version, (progress) => {
        this.#advance(version, progress.percent ?? null)
      })
      .then(
        () => {
          this.#commit({ phase: 'ready', version })
        },
        (cause: unknown) => {
          this.#onFailure('download-update', cause)

          /* 退回可点状态：这枚胶囊本身就是重试入口，下一轮检查会纠正版本。 */
          this.#commit({ phase: 'available', version })
        },
      )
  }

  /** 装上并重启。正常路径上进程会在这之前就被接管。 */
  relaunch = (): void => {
    if (this.#state.phase !== 'ready') {
      return
    }

    void this.#controller.relaunch().catch((cause: unknown) => {
      this.#onFailure('install-update', cause)

      /*
       * 安装失败即那份字节已经被消耗，原生侧的暂存态是空的：留在 ready 只会让下一
       * 次点击必然失败。回到 idle，交给下一轮检查重新发现。
       */
      this.#commit(IDLE)
    })
  }

  /* 进度只许前进：迟到的那一帧被吃掉代价是零，放它过去就是人看着数字倒退。 */
  #advance(version: string, percent: number | null): void {
    const current = this.#state

    if (current.phase !== 'downloading' || current.version !== version) {
      return
    }

    if (percent === null) {
      return
    }

    const next = current.percent === null ? percent : Math.max(current.percent, percent)

    if (next === current.percent) {
      return
    }

    this.#commit({ phase: 'downloading', version, percent: next })
  }

  #commit(next: AppUpdateState): void {
    /* 引用没变就不是变化：IDLE 是同一个对象，重复提交不该惊动订阅者。 */
    if (next === this.#state) {
      return
    }

    this.#state = next

    for (const listener of this.#listeners) {
      listener()
    }
  }
}
