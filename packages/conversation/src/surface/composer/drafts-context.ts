import { createContext, useContext } from 'react'
import type { ComposerDrafts } from '../../composer/drafts'

export const ComposerDraftsContext = createContext<ComposerDrafts | null>(null)

export function useComposerDrafts(): ComposerDrafts {
  const drafts = useContext(ComposerDraftsContext)

  if (drafts === null) {
    throw new Error('这棵组件树上没有 ComposerDraftsContext，离屏草稿无处存放。')
  }

  return drafts
}

/** 这一格的草稿归哪个键。对话是它的 id；入口那一格全局只有一个。 */
export const ComposerDraftKeyContext = createContext<string>('composer:entry')

export function useComposerDraftKey(): string {
  return useContext(ComposerDraftKeyContext)
}
