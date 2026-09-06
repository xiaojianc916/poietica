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
}

export interface PromptInputDraft {
  readonly hasText: boolean
  readonly hasFiles: boolean
  readonly requiresText: boolean
  readonly configuration: readonly PendingPromptConfiguration[]
}

export function canSubmitDraft(
  draft: Pick<PromptInputDraft, 'hasText' | 'hasFiles' | 'requiresText'>,
): boolean {
  return draft.requiresText ? draft.hasText : draft.hasText || draft.hasFiles
}
