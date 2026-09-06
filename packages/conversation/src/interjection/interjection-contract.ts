import type { PromptAsset, PromptConfiguration, PromptSkill } from '../agent'

export interface Interjection {
  readonly id: string
  readonly text: string
  readonly assets: readonly PromptAsset[]
  readonly configuration: readonly PromptConfiguration[]
  readonly skills: readonly PromptSkill[]
  readonly state: 'queued' | 'editing'
}
export type Said = Omit<Interjection, 'id' | 'state'>
export interface SubmissionContext {
  readonly prepare?: (() => Promise<boolean>) | undefined
  readonly onUserMessage?: ((threadId: string, text: string) => void) | undefined
}
export interface OutboxState {
  readonly queue: readonly Interjection[]
  readonly inflight: Interjection | undefined
  readonly editing: string | undefined
  readonly paused: boolean
}
export interface OutboxPort {
  readonly deliver: (said: Interjection, context: SubmissionContext) => Promise<string | null>
  readonly merge: (promptId: string) => Promise<void>
  readonly isBusy: () => boolean
  readonly failed: (cause: unknown) => void
}
