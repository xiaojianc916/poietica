import type { DraftAttachments } from '@poietica/feature-conversation/ui-api'

/**
 * 草稿附件的引用登记。三条规矩：`ids()` 为 null（草稿还没从盘上恢复）时**什么都不发** —— 空集合不等于「草稿是空的」；整体替换、按集合键去重，
 * 集合没变就不重复请求；请求串行 —— 整体替换是后写覆盖，两次未完成的请求交错会互相盖掉。
 */
export const DRAFTS_OWNER = 'ui:conversation.drafts'
export const DRAFT_PIN_DEBOUNCE_MS = 500

export interface DraftRefSyncDeps {
  readonly drafts: DraftAttachments
  readonly setOwnerRefs: (ownerKey: string, attachmentIds: readonly string[]) => Promise<{ missing: string[] }>
  readonly warn: (message: string, data: Record<string, unknown>) => void
  readonly reportMissing: (count: number) => void
  readonly debounceMs?: number
}

export interface DraftRefSync {
  schedule(): void
  /** 无条件重发一次（上一代 Core 收到的那份引用不算数） */
  onCoreReady(): void
  flush(): Promise<void>
  dispose(): void
}

export function createDraftRefSync(d: DraftRefSyncDeps): DraftRefSync {
  const delay = d.debounceMs ?? DRAFT_PIN_DEBOUNCE_MS
  let pinned: string | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let chain: Promise<void> = Promise.resolve()
  let disposed = false

  const pinNow = async (): Promise<void> => {
    if (disposed) return
    /* 整段都在 try 里：`schedule()` 用 `void flush()` 起这一段，守则 8.1 不允许出现没有 `.catch` 的游离 promise —— 这里自己收干净。 */
    try {
      const ids = d.drafts.ids()
      if (ids === null) return
      const key = ids.join('\n')
      if (key === pinned) return
      const { missing } = await d.setOwnerRefs(DRAFTS_OWNER, ids)
      pinned = key
      if (missing.length > 0) {
        const removed = d.drafts.drop(missing)
        if (removed > 0) d.reportMissing(removed)
      }
    } catch (cause) {
      pinned = null
      d.warn('draft attachment pin failed', { error: String(cause) })
    }
  }

  const flush = async (): Promise<void> => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    chain = chain.then(pinNow)
    await chain
  }

  const schedule = (): void => {
    if (disposed) return
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      void flush()
    }, delay)
  }

  return {
    schedule,
    onCoreReady() {
      pinned = null
      schedule()
    },
    flush,
    dispose() {
      disposed = true
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
    },
  }
}
