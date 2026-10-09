import type { PromptConfiguration, PromptSkill } from '../agent/session'
import type { ComposerAsset } from './attachment'

export interface PendingPromptConfiguration extends PromptConfiguration {
  readonly label: string
}

export interface PromptInputMessage {
  readonly text: string
  readonly configuration: readonly PromptConfiguration[]
  readonly assets: readonly ComposerAsset[]
  readonly skills: readonly PromptSkill[]
  /**
   * 人点名「排队」而不是「现在插话」（Ctrl/Cmd + Enter）。
   *
   * 只有正在跑的时候才有分别：空闲时两种都是开一轮。排队走 followUp 那一层 ——
   * 不打断，这一轮跑完接着做。
   */
  readonly queued?: boolean
}

export interface PromptInputDraft {
  readonly hasText: boolean
  readonly hasFiles: boolean
  readonly requiresText: boolean
  readonly configuration: readonly PendingPromptConfiguration[]
}

export function canSubmitDraft(draft: Pick<PromptInputDraft, 'hasText' | 'hasFiles' | 'requiresText'>): boolean {
  return draft.requiresText ? draft.hasText : draft.hasText || draft.hasFiles
}
