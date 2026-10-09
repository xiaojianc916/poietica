import type { SerializedEditorState } from 'lexical'
import type { ComposerAsset } from './attachment'
import type { PendingPromptConfiguration } from './prompt'

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
