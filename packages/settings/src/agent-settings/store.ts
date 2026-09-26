import type { AgentSettingEntry, AgentSettingsCatalog, AgentSettingsPort } from './model'

/*
 * agent 设置目录的持有者：一次读、一次写、一个写点。
 *
 * 写完之后不乐观改写本地状态，而是拿 agent 交回的那整份目录换掉快照 —— 改没改由它说，
 * 写的是它自己的盘（ADR 0054）。所以下面的动作都是「等结果、换快照」，没有第二个写点。
 */

const EMPTY: AgentSettingsSnapshot = Object.freeze({
  catalog: null,
  loading: false,
  saving: null,
  error: null,
})

export interface AgentSettingsSnapshot {
  readonly catalog: AgentSettingsCatalog | null
  readonly loading: boolean
  /** 正在写的那一格的路径；没有写就是 null。 */
  readonly saving: string | null
  readonly error: string | null
}

export class AgentSettingsStore {
  readonly #port: AgentSettingsPort
  readonly #listeners = new Set<() => void>()
  #snapshot = EMPTY
  #generation = 0
  #loading: Promise<void> | null = null
  #disposed = false

  constructor(port: AgentSettingsPort) {
    this.#port = port
  }

  readonly getSnapshot = (): AgentSettingsSnapshot => this.#snapshot

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#requireActive()
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  dispose(): void {
    this.#disposed = true
    this.#generation += 1
    this.#listeners.clear()
  }

  load = (): Promise<void> => {
    if (this.#disposed) {
      return Promise.reject(stoppedCatalog())
    }
    if (this.#snapshot.catalog !== null) {
      return Promise.resolve()
    }
    if (this.#loading !== null) {
      return this.#loading
    }
    const pending = this.refresh()
    this.#loading = pending
    const settle = () => {
      if (this.#loading === pending) {
        this.#loading = null
      }
    }
    void pending.then(settle, settle)
    return pending
  }

  refresh = async (): Promise<void> => {
    this.#requireActive()
    const generation = ++this.#generation
    this.#publish({ ...this.#snapshot, loading: true, error: null })
    try {
      const catalog = await this.#port.read()
      if (generation === this.#generation) {
        this.#publish({ catalog, loading: false, saving: null, error: null })
      }
    } catch (cause) {
      if (generation === this.#generation) {
        this.#publish({ ...this.#snapshot, loading: false, error: describe(cause) })
      }
    }
  }

  /**
   * 改一格。
   *
   * 失败时**换回原快照**（只是把 error 写上去），因为它交回的那份目录才作数；
   * 乐观改过的值在这里被丢弃是对的 —— 屏幕上要显示的是 agent 那头的事实。
   */
  write = async (path: string, value: unknown): Promise<void> => {
    this.#requireActive()
    const generation = ++this.#generation
    this.#publish({ ...this.#snapshot, saving: path, error: null })
    try {
      const settings = await this.#port.write(path, value)
      if (generation === this.#generation) {
        this.#publish({
          catalog: replaceSettings(this.#snapshot.catalog, settings),
          loading: false,
          saving: null,
          error: null,
        })
      }
    } catch (cause) {
      if (generation === this.#generation) {
        this.#publish({ ...this.#snapshot, saving: null, error: describe(cause) })
      }
      throw cause
    }
  }

  /**
   * 把 agent 自己的配置文件交给系统编辑器。
   *
   * 这不是「提交一次改动」，所以不碰快照：改没改由 agent 自己说，下一次读目录才作数
   * （它自己看盘）。失败如实写进 error —— 静默失败会让人以为按钮坏了。
   */
  openConfigFile = async (): Promise<void> => {
    this.#requireActive()
    try {
      await this.#port.openConfigFile()
    } catch (cause) {
      const generation = this.#generation

      if (generation === this.#generation) {
        this.#publish({ ...this.#snapshot, error: describe(cause) })
      }

      throw cause
    }
  }

  #requireActive(): void {
    if (this.#disposed) {
      throw stoppedCatalog()
    }
  }

  #publish(snapshot: AgentSettingsSnapshot): void {
    this.#snapshot = Object.freeze(snapshot)
    for (const listener of this.#listeners) {
      listener()
    }
  }
}

/*
 * 写回来的只是 settings 那一格，栏位表照旧。
 *
 * 栏位表在一次写入里不会变（它是 agent 自己的 tab 词汇，不是某一次写入的产物），
 * 所以这里不重问它 —— 重问就是两个到达时刻，导航会在两次绘制之间抖一下。
 * 配置文件那两格同理：写一格设置不会换 home。
 */
function replaceSettings(
  catalog: AgentSettingsCatalog | null,
  settings: readonly AgentSettingEntry[],
): AgentSettingsCatalog {
  return {
    tabs: catalog?.tabs ?? [],
    settings,
    configFile: catalog?.configFile ?? '',
    configFileExists: catalog?.configFileExists ?? false,
  }
}
function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function stoppedCatalog(): DOMException {
  return new DOMException('Agent settings are disposed.', 'AbortError')
}
