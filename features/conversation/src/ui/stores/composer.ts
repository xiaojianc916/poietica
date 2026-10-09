import { createFeatureStore, type FeatureStore } from '@poietica/ui-kernel'
import type { DraftAttachment } from '../../ui-api'
import type { DraftSelection } from '../entry-init'

/**
 * 入口页那排选择器的本地草稿（07 页 §5E「新对话入口页的选择器」）：
 * 只改本地、不改全局默认；发送时带进 `threads.create`。
 *
 * 它**只在入口页**（threadId 为 null）用得上，因此挂在草稿的同一格里、随
 * `conversation.drafts` 一起落盘 —— 这就是 07 页说的「入口页草稿另存选择器的值
 * { model, thinking, posture }」，重开软件后这一趟的选择还在。
 */
/** 入口页选择器的值：形状与组件那一份逐字一致（entry-init 的 DraftSelection）。 */
export type EntrySelection = DraftSelection

/** 每个线程一份草稿（文本、附件、技能）；草稿持久化到 uiState 的 'conversation.drafts' */
export interface Draft {
  readonly text: string
  readonly attachments: readonly DraftAttachment[]
  readonly skills: readonly string[]
  /** 入口页选择器的值（07 页 §5E）；别的键上缺席。 */
  readonly selection?: EntrySelection
}

export const EMPTY_DRAFT: Draft = { text: '', attachments: [], skills: [] }

export interface ComposerState {
  /** threadId 为键；home 页的新对话用 '__new__'（还不存在的线程） */
  readonly drafts: Readonly<Record<string, Draft>>
  readonly submitting: boolean
}

export const NEW_THREAD_KEY = '__new__'
export const draftKeyOf = (threadId: string | null): string => threadId ?? NEW_THREAD_KEY

export interface ComposerStore {
  readonly store: FeatureStore<ComposerState>
  draft(threadId: string | null): Draft
  setText(threadId: string | null, text: string): void
  addAttachments(threadId: string | null, items: readonly DraftAttachment[]): void
  removeAttachment(threadId: string | null, id: string): void
  addSkill(threadId: string | null, skill: string): void
  /** 入口页改一格选择器：只动本地草稿，不下发（07 页 §5E）。 */
  setSelection(threadId: string | null, patch: EntrySelection): void
  selectionOf(threadId: string | null): EntrySelection
  clear(threadId: string | null): void
  restore(threadId: string | null, draft: Draft): void
  /**
   * 从所有草稿里移除这些附件 id（R-07 §3.4：Core 回报 missing 时清理）。
   *
   * 内容没变不换引用；返回实际移除的条数。
   */
  dropAttachments(ids: readonly string[]): number
  setSubmitting(v: boolean): void
  /** 启动时把 uiState 里那份草稿读回来（持久化用）。 */
  hydrate(drafts: Readonly<Record<string, Draft>>): void
  /** 持久化用：只留非空草稿 */
  snapshot(): Readonly<Record<string, Draft>>
}

export function createComposerStore(initial: Readonly<Record<string, Draft>> = {}): ComposerStore {
  const store = createFeatureStore<ComposerState>(() => ({ drafts: initial, submitting: false }))
  const read = (threadId: string | null): Draft => store.getState().drafts[draftKeyOf(threadId)] ?? EMPTY_DRAFT

  /** 清空正文、附件与技能，但**保住入口页的选择器**（07 页 §5E：发送后草稿的 init 保留）。 */
  const cleared = (d: Draft): Draft =>
    d.selection === undefined ? EMPTY_DRAFT : { ...EMPTY_DRAFT, selection: d.selection }

  const patch = (threadId: string | null, next: (d: Draft) => Draft): void => {
    const key = draftKeyOf(threadId)
    store.setState((s) => ({ drafts: { ...s.drafts, [key]: next(s.drafts[key] ?? EMPTY_DRAFT) } }))
  }

  return {
    store,
    draft: read,
    setText: (threadId, text) => {
      patch(threadId, (d) => ({ ...d, text }))
    },
    addAttachments: (threadId, items) => {
      if (items.length === 0) return
      patch(threadId, (d) => ({ ...d, attachments: [...d.attachments, ...items] }))
    },
    removeAttachment: (threadId, id) => {
      patch(threadId, (d) => ({ ...d, attachments: d.attachments.filter((a) => a.id !== id) }))
    },
    addSkill: (threadId, skill) => {
      patch(threadId, (d) => (d.skills.includes(skill) ? d : { ...d, skills: [...d.skills, skill] }))
    },
    setSelection: (threadId, patch_) => {
      patch(threadId, (d) => ({ ...d, selection: { ...d.selection, ...patch_ } }))
    },
    selectionOf: (threadId) => read(threadId).selection ?? {},
    clear: (threadId) => {
      patch(threadId, cleared)
    },
    restore: (threadId, draft) => {
      /* 迁移到线程名下的草稿不再带入口页的选择器：那是入口那一格的事。 */
      patch(threadId, () => ({ text: draft.text, attachments: draft.attachments, skills: draft.skills }))
    },
    dropAttachments: (ids) => {
      if (ids.length === 0) return 0
      const drop = new Set(ids)
      const drafts = store.getState().drafts
      const next: Record<string, Draft> = {}
      let removed = 0
      for (const [key, draft] of Object.entries(drafts)) {
        const kept = draft.attachments.filter((a) => !drop.has(a.id))
        removed += draft.attachments.length - kept.length
        next[key] = kept.length === draft.attachments.length ? draft : { ...draft, attachments: kept }
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
    snapshot: () => {
      const out: Record<string, Draft> = {}
      for (const [key, draft] of Object.entries(store.getState().drafts)) {
        if (
          draft.text.trim() === '' &&
          draft.attachments.length === 0 &&
          draft.skills.length === 0 &&
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
