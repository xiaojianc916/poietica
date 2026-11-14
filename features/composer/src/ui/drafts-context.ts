import { createContext, useContext } from 'react'
import type { ComposerStore } from './composer-store'

/** 输入框离屏/在屏的草稿键：对话页是 threadId，入口页是这一个。 */
export const ENTRY_DRAFT_KEY = 'composer:entry'

export const ComposerDraftKeyContext = createContext<string>(ENTRY_DRAFT_KEY)

export function useComposerDraftKey(): string {
  return useContext(ComposerDraftKeyContext)
}

/** 草稿的持久事实源；单测 / 单独渲染输入框时可以是 null（不落账，只活在这一棵树上）。 */
export const ComposerStoreContext = createContext<ComposerStore | null>(null)

export function useComposerStore(): ComposerStore | null {
  return useContext(ComposerStoreContext)
}

/** 草稿键 → 线程号；入口页（空串 / ENTRY_DRAFT_KEY）是 null。 */
export function draftThreadIdOf(key: string): string | null {
  return key === '' || key === ENTRY_DRAFT_KEY ? null : key
}
