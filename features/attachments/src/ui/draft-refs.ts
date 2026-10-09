import type { DraftAttachments } from '@poietica/feature-conversation/ui-api'

/**
 * 草稿附件的引用登记（R-07 §3.4 的方案 1：由 attachments 的 UI 调自己的契约）。
 *
 * 三条规矩：
 * - `ids()` 为 null（草稿还没从盘上恢复）时**什么都不发** —— 空集合不等于「草稿是空的」；
 * - 整体替换、按集合键去重：丢一次、重发一次都不会漂移，集合没变就不重复请求；
 * - 请求串行：整体替换是后写覆盖，两次未完成的请求交错会互相盖掉。
 */
export const DRAFTS_OWNER = 'ui:conversation.drafts'
export const DRAFT_PIN_DEBOUNCE_MS = 500

export interface DraftRefSyncDeps {
  readonly drafts: DraftAttachments
  readonly setOwnerRefs: (ownerKey: string, attachmentIds: readonly string[]) => Promise<{ missing: string[] }>
  /** 请求失败只记 warn：下一次草稿变化或 Core ready 会重发 */
  readonly warn: (message: string, data: Record<string, unknown>) => void
  /** 有失效附件被清掉时提示用户（数量是实际移除的条数） */
  readonly reportMissing: (count: number) => void
  /** 测试注入；缺省 500ms */
  readonly debounceMs?: number
}

export interface DraftRefSync {
  /** 草稿集合变了 / Core ready：去抖后同步一次 */
  schedule(): void
  /** Core 每次进入 ready 都调：无条件重发一次（上一代 Core 收到的那份引用不算数） */
  onCoreReady(): void
  /** 测试与关停用：立刻跑完排队的那一次同步 */
  flush(): Promise<void>
  dispose(): void
}

export function createDraftRefSync(d: DraftRefSyncDeps): DraftRefSync {
  const delay = d.debounceMs ?? DRAFT_PIN_DEBOUNCE_MS
  /** 上次**成功登记**的集合键；null = 必须重发 */
  let pinned: string | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let chain: Promise<void> = Promise.resolve()
  let disposed = false

  const pinNow = async (): Promise<void> => {
    if (disposed) return
    /*
     * 整段都在 try 里：`schedule()` 用 `void flush()` 起这一段，而守则 8.1 不允许
     * 出现没有 `.catch` 的游离 promise —— 这里自己收干净，链子上就不会有 rejection。
     */
    try {
      const ids = d.drafts.ids()
      if (ids === null) return
      const key = ids.join('\n')
      if (key === pinned) return
      const { missing } = await d.setOwnerRefs(DRAFTS_OWNER, ids)
      pinned = key
      if (missing.length > 0) {
        /* 这一步会改草稿 → 订阅回调再排一次同步，下一次自然带上正确的集合 */
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
