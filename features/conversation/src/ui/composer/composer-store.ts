import type { ModelRef } from '@poietica/engine'
import { createFeatureStore, type FeatureStore } from '@poietica/ui-kernel'
import type { SerializedEditorState } from 'lexical'
import type { DraftAttachment } from '../../ui-api'
import type { DraftSelection } from '../entry-init'
import { type ComposerAsset, composerAssetOf } from './attachment'
import { appendText, textDocument } from './draft-document'
import type { PendingPromptConfiguration } from './prompt'

/**
 * 入口页选择器里**还没落账**的那一笔；发送时带进 `threads.create`。模型 / 档位写穿新对话默认意图成功后由 `settleSelection` 抹掉，
 * 写失败才留在这里。它**只在入口页**（threadId 为 null）用得上，因此挂在草稿的同一格里、随 `conversation.drafts` 一起落盘。
 */
/** 形状与组件那一份逐字一致（entry-init 的 DraftSelection）。 */
export type EntrySelection = DraftSelection

/**
 * 每个线程一份草稿。**正文的持久事实是 Lexical 的 SerializedEditorState**：技能 chip、文件 / 元素记号
 * 在正文里的位置、附件与待发配置都在 `document` 这一棵树里；`assets` / `configuration` 是发送需要的
 * 随附数据，不是正文的第二份读法。持久化到 uiState 的 `conversation.drafts.v2`（旧扁平形状不再读取）。
 */
export interface Draft {
  readonly document?: SerializedEditorState | undefined
  readonly assets: readonly ComposerAsset[]
  readonly configuration: readonly PendingPromptConfiguration[]
  /** 入口页选择器的值；别的键上缺席。 */
  readonly selection?: EntrySelection
}

export const EMPTY_DRAFT: Draft = { assets: [], configuration: [] }

/** 盘上读回来的形状校验：旧扁平草稿（text/attachments/skills）没有这两个数组，直接当没有存值。 */
export function isDraft(value: unknown): value is Draft {
  if (typeof value !== 'object' || value === null) return false
  const draft = value as Record<string, unknown>
  if (!Array.isArray(draft.assets) || !Array.isArray(draft.configuration)) return false
  return draft.document === undefined || (typeof draft.document === 'object' && draft.document !== null)
}

export interface ComposerState {
  /** threadId 为键；home 页的新对话用 '__new__' */
  readonly drafts: Readonly<Record<string, Draft>>
  readonly submitting: boolean
  /**
   * 入口页那一格「可以读控件表了」：盘上的草稿（含选择器）已经读回来，或者确定读不回来。
   * 在这之前入口页**不**向 Core 要草稿控件表 —— 空草稿换来的是兜底模型，先画出来再被盘上的选择盖掉，
   * 就是「打开软件先显示另一条模型、改一次档位才变成自己选的」（真实故障）。
   */
  readonly entryReady: boolean
}

export const NEW_THREAD_KEY = '__new__'
export const draftKeyOf = (threadId: string | null): string => threadId ?? NEW_THREAD_KEY

export interface ComposerStore {
  readonly store: FeatureStore<ComposerState>
  draft(threadId: string | null): Draft
  /** 编辑器的整份文档与随附数据一起落账；这是草稿的正常写入路径。 */
  setDocument(
    threadId: string | null,
    document: SerializedEditorState | undefined,
    assets: readonly ComposerAsset[],
    configuration: readonly PendingPromptConfiguration[],
  ): void
  /** 纯文本写入：测试与未挂载路径用；会换成一份只有正文的文档。 */
  setText(threadId: string | null, text: string): void
  /** 未挂载时插字：在文档末尾追加，不另存一份文本。 */
  insertText(threadId: string | null, text: string): void
  addAttachments(threadId: string | null, items: readonly DraftAttachment[]): void
  removeAttachment(threadId: string | null, id: string): void
  /** 入口页改一格选择器：只动本地草稿，不下发。 */
  setSelection(threadId: string | null, patch: EntrySelection): void
  selectionOf(threadId: string | null): EntrySelection
  /**
   * 模型 / 档位已写成默认意图：抹掉草稿里**仍等于写出去那个值**的键。写的途中人又改了一格，那一格不等于
   * 写出去的值，就留着等下一次写 —— 不能整格清空，否则那一下改动丢了。
   */
  settleSelection(
    threadId: string | null,
    sent: { readonly model?: ModelRef | null | undefined; readonly thinking?: string | null | undefined },
  ): void
  clear(threadId: string | null): void
  restore(threadId: string | null, draft: Draft): void
  /** Core 回报 missing 时清理（R-07 §3.4）。内容没变不换引用；返回实际移除的条数。 */
  dropAttachments(ids: readonly string[]): number
  setSubmitting(v: boolean): void
  /** 启动时把 uiState 里那份草稿读回来（持久化用）。 */
  hydrate(drafts: Readonly<Record<string, Draft>>): void
  /** 草稿恢复这一步结束（成功或确定失败）：只翻一次，之后恒为 true。 */
  markEntryReady(): void
  /** 持久化用：只留非空草稿 */
  snapshot(): Readonly<Record<string, Draft>>
}

function sameModel(left: ModelRef | null | undefined, right: ModelRef | null): boolean {
  if (left === undefined) return false
  if (left === null || right === null) return left === right
  return left.provider === right.provider && left.id === right.id
}

export function createComposerStore(initial: Readonly<Record<string, Draft>> = {}): ComposerStore {
  const store = createFeatureStore<ComposerState>(() => ({ drafts: initial, submitting: false, entryReady: false }))
  const read = (threadId: string | null): Draft => store.getState().drafts[draftKeyOf(threadId)] ?? EMPTY_DRAFT

  /** 清空正文、附件与配置，但**保住入口页的选择器**（发送后草稿的 init 保留）。 */
  const cleared = (d: Draft): Draft =>
    d.selection === undefined ? EMPTY_DRAFT : { ...EMPTY_DRAFT, selection: d.selection }

  const patch = (threadId: string | null, next: (d: Draft) => Draft): void => {
    const key = draftKeyOf(threadId)
    store.setState((s) => ({ drafts: { ...s.drafts, [key]: next(s.drafts[key] ?? EMPTY_DRAFT) } }))
  }

  return {
    store,
    draft: read,
    setDocument: (threadId, document, assets, configuration) => {
      patch(threadId, (d) => ({ ...d, document, assets, configuration }))
    },
    setText: (threadId, text) => {
      patch(threadId, (d) => ({ ...d, document: text.trim() === '' ? undefined : textDocument(text) }))
    },
    insertText: (threadId, text) => {
      if (text === '') return
      patch(threadId, (d) => ({ ...d, document: appendText(d.document, text) }))
    },
    addAttachments: (threadId, items) => {
      if (items.length === 0) return
      patch(threadId, (d) => ({ ...d, assets: [...d.assets, ...items.map(composerAssetOf)] }))
    },
    removeAttachment: (threadId, id) => {
      patch(threadId, (d) => ({ ...d, assets: d.assets.filter((a) => a.assetToken !== id) }))
    },
    setSelection: (threadId, patch_) => {
      patch(threadId, (d) => ({ ...d, selection: { ...d.selection, ...patch_ } }))
    },
    selectionOf: (threadId) => read(threadId).selection ?? {},
    settleSelection: (threadId, sent) => {
      const held = read(threadId).selection
      if (held === undefined) return
      const dropModel = sent.model !== undefined && sameModel(held.model, sent.model)
      const dropThinking = sent.thinking !== undefined && held.thinking === sent.thinking
      if (!dropModel && !dropThinking) return
      const { model, thinking, ...rest } = held
      const next: EntrySelection = {
        ...rest,
        ...(dropModel || model === undefined ? {} : { model }),
        ...(dropThinking || thinking === undefined ? {} : { thinking }),
      }
      patch(threadId, (d) => ({ ...d, selection: next }))
    },
    clear: (threadId) => {
      patch(threadId, cleared)
    },
    restore: (threadId, draft) => {
      /* 线程名下的草稿不带入口页的选择器：那是入口那一格的事。 */
      patch(threadId, () => ({ document: draft.document, assets: draft.assets, configuration: draft.configuration }))
    },
    dropAttachments: (ids) => {
      if (ids.length === 0) return 0
      const drop = new Set(ids)
      const drafts = store.getState().drafts
      const next: Record<string, Draft> = {}
      let removed = 0
      for (const [key, draft] of Object.entries(drafts)) {
        const kept = draft.assets.filter((a) => !drop.has(a.assetToken))
        removed += draft.assets.length - kept.length
        next[key] = kept.length === draft.assets.length ? draft : { ...draft, assets: kept }
      }
      if (removed === 0) return 0
      store.setState({ drafts: next })
      return removed
    },
    setSubmitting: (submitting) => {
      store.setState({ submitting })
    },
    hydrate: (drafts) => {
      store.setState((s) => ({ drafts: { ...s.drafts, ...drafts } }))
    },
    markEntryReady: () => {
      if (!store.getState().entryReady) store.setState({ entryReady: true })
    },
    snapshot: () => {
      const out: Record<string, Draft> = {}
      for (const [key, draft] of Object.entries(store.getState().drafts)) {
        if (
          draft.document === undefined &&
          draft.assets.length === 0 &&
          draft.configuration.length === 0 &&
          (draft.selection === undefined || Object.keys(draft.selection).length === 0)
        ) {
          continue
        }
        out[key] = draft
      }
      return out
    },
  }
}
