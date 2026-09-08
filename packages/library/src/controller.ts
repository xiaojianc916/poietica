import type {
  LibraryCatalog,
  LibraryDocument,
  LibraryReply,
  LibraryRequest,
} from '@poietica/contract/library'

export interface LibraryGateway {
  pick(): Promise<LibraryCatalog | null>
  execute(root: string, request: LibraryRequest): Promise<LibraryReply>
}

export interface LibraryState {
  readonly catalog: LibraryCatalog | null
  readonly document: LibraryDocument | null
  readonly draft: string
  readonly query: string
  readonly busy: boolean
  readonly failure: string | null
}

export class LibraryController {
  private state: LibraryState = {
    catalog: null,
    document: null,
    draft: '',
    query: '',
    busy: false,
    failure: null,
  }
  private readonly listeners = new Set<() => void>()
  private allowTyping = true
  private disposed = false
  private pending: Promise<boolean> | null = null

  private readonly gateway: LibraryGateway
  private readonly describe: (cause: unknown) => string

  constructor(gateway: LibraryGateway, describe: (cause: unknown) => string) {
    this.gateway = gateway
    this.describe = describe
  }

  readonly getSnapshot = (): LibraryState => this.state
  readonly subscribe = (receive: () => void): (() => void) => {
    this.listeners.add(receive)
    return () => {
      this.listeners.delete(receive)
    }
  }

  private publish(change: Partial<LibraryState>): void {
    this.state = { ...this.state, ...change }
    for (const receive of this.listeners) {
      receive()
    }
  }

  get dirty(): boolean {
    return this.state.document !== null && this.state.draft !== this.state.document.content
  }

  readonly edit = (draft: string): void => {
    if (!this.disposed && this.allowTyping && this.state.document !== null) {
      this.publish({ draft })
    }
  }

  readonly clearFailure = (): void => {
    this.publish({ failure: null })
  }

  private operation(run: () => Promise<void>, allowTyping = false): Promise<boolean> {
    if (this.disposed || this.pending !== null) {
      return Promise.resolve(false)
    }
    this.allowTyping = allowTyping
    this.publish({ busy: true, failure: null })
    const pending = Promise.resolve()
      .then(run)
      .then(
        () => true,
        (cause: unknown) => {
          this.publish({ failure: this.describe(cause) })
          return false
        },
      )
      .finally(() => {
        this.pending = null
        this.allowTyping = true
        this.publish({ busy: false })
      })
    this.pending = pending
    return pending
  }

  private async request(request: LibraryRequest): Promise<LibraryReply> {
    const root = this.state.catalog?.root
    if (root === undefined) {
      throw new Error('请先打开资料文件夹。')
    }
    return this.gateway.execute(root, request)
  }

  private async refresh(query = this.state.query): Promise<void> {
    const reply = await this.request({ kind: 'list', query })
    if (reply.kind !== 'catalog') {
      throw new Error('资料库返回了错误的目录契约。')
    }
    this.publish({ catalog: reply.value, query })
  }

  private async saveDraft(): Promise<void> {
    const document = this.state.document
    if (!document || !this.dirty) {
      return
    }
    const submitted = this.state.draft
    const reply = await this.request({
      kind: 'save',
      path: document.path,
      expected: document.content,
      content: submitted,
    })
    if (reply.kind !== 'document') {
      throw new Error('资料库返回了错误的保存契约。')
    }
    this.publish({ document: reply.value })
  }

  private async flush(): Promise<void> {
    await this.saveDraft()
    if (this.dirty) {
      throw new Error('保存期间仍有输入；草稿已保留，请完成输入后再切换。')
    }
  }

  readonly choose = (): Promise<boolean> =>
    this.operation(async () => {
      await this.flush()
      const catalog = await this.gateway.pick()
      if (catalog !== null && this.dirty) {
        throw new Error('选择目录期间仍有输入，草稿已保留；请另存后继续。')
      }
      if (catalog !== null) {
        this.publish({ catalog, document: null, draft: '', query: '' })
      }
    })

  readonly open = (path: string): Promise<boolean> =>
    this.operation(async () => {
      await this.flush()
      const reply = await this.request({ kind: 'read', path })
      if (reply.kind !== 'document') {
        throw new Error('资料库返回了错误的读取契约。')
      }
      this.publish({ document: reply.value, draft: reply.value.content })
    })

  readonly save = (): Promise<boolean> =>
    this.operation(async () => {
      await this.saveDraft()
      await this.refresh()
    }, true)

  readonly search = (query: string): Promise<boolean> => this.operation(() => this.refresh(query))

  readonly create = (path: string, content = ''): Promise<boolean> =>
    this.operation(async () => {
      await this.flush()
      const reply = await this.request({ kind: 'create', path, content })
      if (reply.kind !== 'document') {
        throw new Error('资料库返回了错误的新建契约。')
      }
      this.publish({ document: reply.value, draft: reply.value.content })
      await this.refresh('')
    })

  readonly import = (path: string, read: () => Promise<string>): Promise<boolean> =>
    this.operation(async () => {
      await this.flush()
      const content = await read()
      const reply = await this.request({ kind: 'create', path, content })
      if (reply.kind !== 'document') {
        throw new Error('资料库返回了错误的导入契约。')
      }
      this.publish({ document: reply.value, draft: reply.value.content })
      await this.refresh('')
    })

  readonly saveCopy = (path: string): Promise<boolean> =>
    this.operation(async () => {
      const content = this.state.draft
      const reply = await this.request({ kind: 'create', path, content })
      if (reply.kind !== 'document') {
        throw new Error('资料库返回了错误的另存契约。')
      }
      this.publish({ document: reply.value, draft: content })
      await this.refresh('')
    })

  readonly folder = (path: string): Promise<boolean> =>
    this.operation(async () => {
      const reply = await this.request({ kind: 'folder', path })
      if (reply.kind !== 'done') {
        throw new Error('资料库返回了错误的目录创建契约。')
      }
      await this.refresh('')
    })

  readonly trash = (): Promise<boolean> =>
    this.operation(async () => {
      await this.flush()
      const document = this.state.document
      if (!document) {
        return
      }
      const reply = await this.request({
        kind: 'trash',
        path: document.path,
        expected: document.content,
      })
      if (reply.kind !== 'done') {
        throw new Error('资料库返回了错误的回收站契约。')
      }
      this.publish({ document: null, draft: '' })
      await this.refresh()
    })

  readonly dispose = async (): Promise<void> => {
    this.disposed = true
    await this.pending
    if (this.dirty) {
      try {
        await this.saveDraft()
      } catch (cause) {
        this.publish({ failure: this.describe(cause) })
        throw cause
      }
    }
    this.listeners.clear()
  }
}
