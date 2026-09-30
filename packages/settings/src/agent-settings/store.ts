import type { AgentSettingsCatalog, AgentSettingsPort } from './model'

/*
 * agent 设置目录的持有者：一次读、一次写、一个写点。
 *
 * 写完之后不乐观改写本地状态，而是拿 agent 交回的那整份目录换掉快照 —— 改没改由它说，
 * 写的是它自己的盘（ADR 0018）。所以下面的动作都是「等结果、换快照」，没有第二个写点。
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
        /* 只换 settings 那一格：写一格设置不会换那份目录的身份。 */
        this.#publish({
          catalog: { settings },
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

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function stoppedCatalog(): DOMException {
  return new DOMException('Agent settings are disposed.', 'AbortError')
}
