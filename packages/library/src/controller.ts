import type {
  LibraryDocument,
  LibraryEntry,
  LibraryFormat,
  LibraryReply,
  LibraryRequest,
} from '@poietica/contract/library'

/** 输入即时进真相，检索延后触发：一次按键不该换来一次全树遍历。 */
const SEARCH_DELAY = 200

/** 资料库的原生端口。根不在参数里：它归原生侧，渲染层无从指定。 */
export interface LibraryGateway {
  readonly execute: (request: LibraryRequest) => Promise<LibraryReply>
  /** 宿主弹出文件选择器并把选中文件复制进库；用户取消时返回 null。 */
  readonly importFile: (parent: string) => Promise<LibraryReply | null>
}

export interface LibraryState {
  readonly entries: readonly LibraryEntry[]
  readonly document: LibraryDocument | null
  readonly draft: string
  readonly query: string
  readonly busy: boolean
  readonly failure: string | null
}

const EMPTY: LibraryState = {
  entries: [],
  document: null,
  draft: '',
  query: '',
  busy: false,
  failure: null,
}

/** ancestor 是不是 path 自己或它的祖先。两种分隔符都认：路径由原生侧签发。 */
function within(ancestor: string, path: string): boolean {
  return path === ancestor || path.startsWith(`${ancestor}/`) || path.startsWith(`${ancestor}\\`)
}

/**
 * 资料库在渲染侧的唯一投影。
 *
 * 磁盘是真相，这里只是它的投影：每一次写入都发一条请求、拿到回复再重投影，
 * 没有第二条写路径，也没有先改本地再同步的影子副本。
 */
export class LibraryController {
  private state: LibraryState = EMPTY
  private readonly listeners = new Set<() => void>()
  private queue: Promise<unknown> = Promise.resolve()
  private timer: ReturnType<typeof setTimeout> | null = null
  private loaded = false
  private disposed = false

  private readonly gateway: LibraryGateway
  private readonly describe: (cause: unknown) => string

  constructor(gateway: LibraryGateway, describe: (cause: unknown) => string) {
    this.gateway = gateway
    this.describe = describe
  }

  readonly getSnapshot = (): LibraryState => this.state

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)

    return () => {
      this.listeners.delete(listener)
    }
  }

  /** 有没有未落盘的编辑。 */
  get dirty(): boolean {
    return this.state.document !== null && this.state.draft !== this.state.document.content
  }

  readonly edit = (draft: string): void => {
    if (this.state.document !== null) {
      this.publish({ draft })
    }
  }

  readonly clearFailure = (): void => {
    this.publish({ failure: null })
  }

  /** 首次进入资料库时装载目录，重复调用无副作用。 */
  readonly start = (): Promise<boolean> => {
    if (this.loaded) {
      return Promise.resolve(true)
    }

    this.loaded = true

    return this.operation(() => this.catalog())
  }

  readonly search = (query: string): void => {
    this.publish({ query })

    if (this.timer !== null) {
      clearTimeout(this.timer)
    }

    this.timer = setTimeout(() => {
      this.timer = null
      void this.operation(() => this.catalog())
    }, SEARCH_DELAY)
  }

  readonly open = (path: string): Promise<boolean> =>
    this.operation(async () => {
      await this.persist()

      return this.read(path)
    })

  readonly save = (): Promise<boolean> => this.operation(async () => (await this.persist()) ?? {})

  readonly create = (parent: string, format: LibraryFormat): Promise<boolean> =>
    this.operation(async () => {
      await this.persist()

      const placed = await this.place({ kind: 'create', parent, format })

      return { ...(await this.catalog()), ...(await this.read(placed)) }
    })

  readonly folder = (parent: string): Promise<boolean> =>
    this.operation(async () => {
      await this.place({ kind: 'folder', parent })

      return this.catalog()
    })

  readonly importFile = (parent: string): Promise<boolean> =>
    this.operation(async () => {
      const reply = await this.gateway.importFile(parent)

      if (reply === null) {
        return {}
      }
      if (reply.kind !== 'placed') {
        throw new Error(`资料库回复了 ${reply.kind}，期待 placed。`)
      }

      return { ...(await this.catalog()), ...(await this.read(reply.value)) }
    })

  readonly rename = (path: string, name: string): Promise<boolean> =>
    this.operation(async () => {
      const placed = await this.place({ kind: 'rename', path, name })
      const open = this.state.document
      const moved = open !== null && within(path, open.path) ? await this.read(placed) : {}

      return { ...(await this.catalog()), ...moved }
    })

  readonly trash = (path: string): Promise<boolean> =>
    this.operation(async () => {
      await this.expect({ kind: 'trash', path }, 'done')

      const open = this.state.document
      const closed = open !== null && within(path, open.path) ? { document: null, draft: '' } : {}

      return { ...(await this.catalog()), ...closed }
    })

  /** 离开资料库前把草稿落盘，然后不再接受任何意图。 */
  readonly dispose = async (): Promise<void> => {
    if (this.disposed) {
      return
    }

    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }

    await this.operation(async () => (await this.persist()) ?? {})

    this.disposed = true
    this.listeners.clear()
  }

  private publish(next: Partial<LibraryState>): void {
    this.state = { ...this.state, ...next }

    for (const listener of this.listeners) {
      listener()
    }
  }

  /** 请求排队而不是被丢掉：连点两次新建应该得到两份文件，不是一份。 */
  private operation(work: () => Promise<Partial<LibraryState>>): Promise<boolean> {
    const queued = this.queue.then(() => this.perform(work))

    this.queue = queued

    return queued
  }

  private async perform(work: () => Promise<Partial<LibraryState>>): Promise<boolean> {
    if (this.disposed) {
      return false
    }

    this.publish({ busy: true, failure: null })

    try {
      const next = await work()

      if (!this.disposed) {
        this.publish({ ...next, busy: false })
      }

      return true
    } catch (cause) {
      if (!this.disposed) {
        this.publish({ busy: false, failure: this.describe(cause) })
      }

      return false
    }
  }

  /** 回复的 tag 到载荷的映射只在这里做一次。 */
  private async expect<K extends LibraryReply['kind']>(
    request: LibraryRequest,
    kind: K,
  ): Promise<Extract<LibraryReply, { kind: K }>> {
    const reply = await this.gateway.execute(request)

    if (reply.kind !== kind) {
      throw new Error(`资料库回复了 ${reply.kind}，期待 ${kind}。`)
    }

    return reply as Extract<LibraryReply, { kind: K }>
  }

  private async catalog(): Promise<Partial<LibraryState>> {
    const reply = await this.expect({ kind: 'list', query: this.state.query }, 'catalog')

    return { entries: reply.value.entries }
  }

  private async read(path: string): Promise<Partial<LibraryState>> {
    const reply = await this.expect({ kind: 'read', path }, 'document')

    return { document: reply.value, draft: reply.value.content }
  }

  private async place(request: LibraryRequest): Promise<string> {
    return (await this.expect(request, 'placed')).value
  }

  private async persist(): Promise<Partial<LibraryState> | null> {
    const open = this.state.document

    if (open === null || this.state.draft === open.content) {
      return null
    }

    const reply = await this.expect(
      { kind: 'save', path: open.path, expected: open.content, content: this.state.draft },
      'document',
    )

    return { document: reply.value, draft: reply.value.content }
  }
}
