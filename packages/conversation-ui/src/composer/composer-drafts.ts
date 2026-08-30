import type { SerializedEditorState } from 'lexical'
import { createContext, useContext } from 'react'
import type { ComposerAsset } from './attachment-intake'
import type { PendingPromptConfiguration } from './prompt-input'

/*
 * 离屏草稿的所有者。
 *
 * 主区同一时刻只挂一个对话表面，换标签页就是卸载。挂着时草稿的唯一真相是编辑器
 * 状态；卸载时它交到这里，装回去时原样取回。两处从不同时持有，所以没有第二份要
 * 同步的副本。只在内存里：一次运行的事实，重启不留。
 */

export interface ComposerDraft {
  readonly editorState: SerializedEditorState
  readonly assets: readonly ComposerAsset[]
  readonly configuration: readonly PendingPromptConfiguration[]
}

export class ComposerDrafts {
  readonly #held = new Map<string, ComposerDraft>()

  /** 取回并交出所有权：一份草稿只装一次。 */
  take(key: string): ComposerDraft | undefined {
    const held = this.#held.get(key)

    this.#held.delete(key)

    return held
  }

  /** 空草稿不占位。 */
  keep(key: string, draft: ComposerDraft | undefined): void {
    if (draft === undefined) {
      this.#held.delete(key)

      return
    }

    this.#held.set(key, draft)
  }
}

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
