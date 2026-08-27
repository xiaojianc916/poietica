import {
  type CustomAgentDraft,
  emptyAgentDraft,
  parseAgentDocument,
  serializeAgentDocument,
  validateAgentDraft,
} from './agent-document'
import type { CustomAgentCatalog, CustomAgentFile, CustomAgentStore } from './custom-agent-store'

/* 新建槽位。用 Symbol 而不是保留字符串：任何字符串都可能撞上真实相对路径。 */
const NEW_AGENT = Symbol('new-agent')

type Selection = string | typeof NEW_AGENT

const EMPTY_DOCUMENT = serializeAgentDocument(emptyAgentDraft())

export type PersonalizationBusy = 'load' | 'save' | 'remove'

export interface PersonalizationEntry {
  readonly relativePath: string
  readonly name: string
  readonly description: string
  readonly isSelected: boolean
  readonly isDirty: boolean
  readonly isBroken: boolean
}

export interface PersonalizationView {
  readonly entries: readonly PersonalizationEntry[]
  readonly issues: readonly string[]
  readonly draft: CustomAgentDraft
  readonly absolutePath: string | null
  readonly isNew: boolean
  readonly isDirty: boolean
  readonly isRemovalArmed: boolean
  readonly validation: string | null
  readonly busy: PersonalizationBusy | null
  readonly failure: string | null
}

interface Row {
  readonly file: CustomAgentFile
  readonly parsed: CustomAgentDraft | null
  /* parsed 的规范序列化。脏判定与它比，磁盘上的键序差异因此不会伪装成未保存。 */
  readonly canonical: string | null
  readonly issue: string | null
}

/**
 * 子 Agent 目录的唯一事实来源。
 *
 * 拥有：目录快照、每个文件的解析结果、按文件保留的草稿、忙态、失败。
 * 不认识 React、设置页与侧边栏；表面只投影这份快照，不另存一份。
 */
export class PersonalizationStore {
  readonly #agents: CustomAgentStore
  readonly #listeners = new Set<() => void>()
  readonly #rows = new Map<string, Row>()
  readonly #drafts = new Map<Selection, CustomAgentDraft>()

  #issues: readonly string[] = []
  #selection: Selection = NEW_AGENT
  #busy: PersonalizationBusy | null = null
  #failure: string | null = null
  #removalArmed = false
  #started = false
  #view: PersonalizationView

  constructor(agents: CustomAgentStore) {
    this.#agents = agents
    this.#drafts.set(NEW_AGENT, emptyAgentDraft())
    this.#view = this.#project()
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)

    return () => {
      this.#listeners.delete(listener)
    }
  }

  getSnapshot = (): PersonalizationView => this.#view

  /* 首次进入这一格读一次目录；再次进入不重读，草稿与选中项因此跨导航保留。 */
  load = (): void => {
    if (this.#started) {
      return
    }

    this.#started = true
    void this.#reload(null)
  }

  refresh = (): void => {
    void this.#reload(this.#selectedPath())
  }

  select = (relativePath: string): void => {
    const row = this.#rows.get(relativePath)

    if (row === undefined) {
      return
    }

    /* 读不成 draft 的文件不进编辑器：那会用空草稿盖掉磁盘上的内容。 */
    this.#failure = row.parsed === null ? relativePath + '：' + row.issue : null
    this.#selection = row.parsed === null ? this.#selection : relativePath
    this.#removalArmed = false
    this.#commit()
  }

  startNew = (): void => {
    this.#selection = NEW_AGENT
    this.#failure = null
    this.#removalArmed = false
    this.#commit()
  }

  edit = (patch: Partial<CustomAgentDraft>): void => {
    this.#drafts.set(this.#selection, { ...this.#draft(), ...patch })
    this.#failure = null
    this.#removalArmed = false
    this.#commit()
  }

  armRemoval = (): void => {
    this.#removalArmed = this.#selectedPath() !== null
    this.#commit()
  }

  disarmRemoval = (): void => {
    this.#removalArmed = false
    this.#commit()
  }

  save = async (): Promise<void> => {
    const draft = this.#draft()

    if (this.#busy !== null || validateAgentDraft(draft) !== null) {
      return
    }

    const selectedPath = this.#selectedPath()
    const relativePath = selectedPath ?? draft.name.trim() + '.md'

    this.#busy = 'save'
    this.#failure = null
    this.#removalArmed = false
    this.#commit()

    try {
      /* expectedDocument 比的是磁盘字节，脏判定比的是规范序列化 —— 两件事不混。 */
      const saved = await this.#agents.save({
        relativePath,
        document: serializeAgentDocument(draft),
        expectedDocument:
          selectedPath === null ? null : (this.#rows.get(selectedPath)?.file.document ?? null),
      })

      this.#drafts.delete(this.#selection)
      this.#drafts.set(NEW_AGENT, this.#drafts.get(NEW_AGENT) ?? emptyAgentDraft())
      this.#ingest(await this.#agents.load())
      this.#selection = this.#rows.has(saved.relativePath) ? saved.relativePath : NEW_AGENT
    } catch (cause: unknown) {
      this.#failure = messageOf(cause)
    } finally {
      this.#busy = null
      this.#commit()
    }
  }

  remove = async (): Promise<void> => {
    const selectedPath = this.#selectedPath()
    const row = selectedPath === null ? undefined : this.#rows.get(selectedPath)

    if (this.#busy !== null || row === undefined) {
      return
    }

    this.#busy = 'remove'
    this.#failure = null
    this.#removalArmed = false
    this.#commit()

    try {
      await this.#agents.remove({
        relativePath: row.file.relativePath,
        expectedDocument: row.file.document,
      })

      this.#drafts.delete(row.file.relativePath)
      this.#ingest(await this.#agents.load())
      this.#selection = this.#firstReadable() ?? NEW_AGENT
    } catch (cause: unknown) {
      this.#failure = messageOf(cause)
    } finally {
      this.#busy = null
      this.#commit()
    }
  }

  async #reload(target: string | null): Promise<void> {
    if (this.#busy !== null) {
      return
    }

    this.#busy = 'load'
    this.#failure = null
    this.#removalArmed = false
    this.#commit()

    try {
      this.#ingest(await this.#agents.load())
      this.#selection =
        (target !== null && this.#rows.has(target) ? target : this.#firstReadable()) ?? NEW_AGENT
    } catch (cause: unknown) {
      this.#failure = messageOf(cause)
    } finally {
      this.#busy = null
      this.#commit()
    }
  }

  /* 每个文件只解析一次，解析结果与规范序列化一起落在 Row 上。 */
  #ingest(catalog: CustomAgentCatalog): void {
    this.#rows.clear()
    this.#issues = catalog.issues

    for (const file of catalog.files) {
      this.#rows.set(file.relativePath, describe(file))
    }

    for (const key of this.#drafts.keys()) {
      if (typeof key === 'string' && !this.#rows.has(key)) {
        this.#drafts.delete(key)
      }
    }
  }

  #selectedPath(): string | null {
    return typeof this.#selection === 'string' ? this.#selection : null
  }

  #firstReadable(): string | null {
    for (const [relativePath, row] of this.#rows) {
      if (row.parsed !== null) {
        return relativePath
      }
    }

    return null
  }

  #draft(): CustomAgentDraft {
    const stored = this.#drafts.get(this.#selection)

    if (stored !== undefined) {
      return stored
    }

    const selectedPath = this.#selectedPath()

    return (
      (selectedPath === null ? null : this.#rows.get(selectedPath)?.parsed) ?? emptyAgentDraft()
    )
  }

  /* 唯一写入点。 */
  #commit(): void {
    this.#view = this.#project()

    for (const listener of this.#listeners) {
      listener()
    }
  }

  #project(): PersonalizationView {
    const selectedPath = this.#selectedPath()
    const draft = this.#draft()
    const document = serializeAgentDocument(draft)
    const baseline =
      selectedPath === null
        ? EMPTY_DOCUMENT
        : (this.#rows.get(selectedPath)?.canonical ?? EMPTY_DOCUMENT)

    const entries = [...this.#rows.values()].map((row) => {
      const stored = this.#drafts.get(row.file.relativePath)

      return {
        relativePath: row.file.relativePath,
        name: row.parsed?.name ?? row.file.relativePath.replace(/\.md$/, ''),
        description: row.parsed?.description ?? row.issue ?? '',
        isSelected: row.file.relativePath === selectedPath,
        isDirty:
          stored !== undefined &&
          row.canonical !== null &&
          serializeAgentDocument(stored) !== row.canonical,
        isBroken: row.parsed === null,
      }
    })

    return {
      entries,
      issues: this.#issues,
      draft,
      absolutePath:
        selectedPath === null ? null : (this.#rows.get(selectedPath)?.file.absolutePath ?? null),
      isNew: selectedPath === null,
      isDirty: document !== baseline,
      isRemovalArmed: this.#removalArmed,
      validation: validateAgentDraft(draft),
      busy: this.#busy,
      failure: this.#failure,
    }
  }
}

function describe(file: CustomAgentFile): Row {
  try {
    const parsed = parseAgentDocument(file.relativePath, file.document)

    return { file, parsed, canonical: serializeAgentDocument(parsed), issue: null }
  } catch (cause: unknown) {
    return { file, parsed: null, canonical: null, issue: messageOf(cause) }
  }
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : '操作失败'
}
