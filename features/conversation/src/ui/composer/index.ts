/*
 * composer 区：输入框、待答卡片、队列与草稿。区与区之间只能经本文件互相引用（docs/ARCHITECTURE.md §4.3）。
 */

export {
  type ComposerStore,
  createComposerStore,
  type Draft,
  type EntrySelection,
  NEW_THREAD_KEY,
} from './composer-store'
export { createDraftPin, type DraftPinView } from './draft-pin'
export { ComposerDraftKeyContext } from './drafts-context'
export type { PromptInputMessage } from './prompt'
export { useAgentToolkit } from './toolkit'
export { AssistantComposer } from './view/assistant-composer'
export { ComposerNotice } from './view/composer-notice'
export { useDockClearance } from './view/dock-clearance'
export type { PermissionDockProps } from './view/permission-dock'
export type { PromptInputHandle } from './view/prompt-input'
export { PromptQueue } from './view/prompt-queue'
export { SwarmToggle } from './view/swarm-toggle'
