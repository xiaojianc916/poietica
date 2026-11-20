import { defineUiFeature } from '@poietica/ui-kernel'

/*
 * composer 区：输入框、待答卡片、队列与草稿。区与区之间只能经本文件互相引用（docs/ARCHITECTURE.md §4.3）。
 */

export { type AttachmentIntake, AttachmentIntakeContext, type ComposerAsset } from './attachment'
export {
  type ComposerStore,
  createComposerStore,
  type Draft,
  type EntrySelection,
  isDraft,
  NEW_THREAD_KEY,
} from './composer-store'
export { projectDocument, textDocument } from './draft-document'
export { createDraftPin, type DraftPinView } from './draft-pin'
export { ComposerDraftKeyContext, ComposerStoreContext, draftThreadIdOf, useComposerStore } from './drafts-context'
export { createLiveComposers, type LiveComposers, LiveComposersContext } from './live-composers'
export type { PromptInputMessage } from './prompt'
export { createSideStore, type SideStore } from './side-store'
export { mergeToolkits, toolkitReaderOf, useAgentToolkit } from './toolkit'
export { AssistantComposer } from './view/assistant-composer'
export { AuxiliaryComposer, AuxiliaryComposerBar, type AuxiliaryComposerBarProps } from './view/auxiliary-composer'
export { ComposerActions, composerPaletteGroups } from './view/composer-actions'
export { ComposerNotice } from './view/composer-notice'
export { ContextGauge, cacheHitRate, gaugeLayout } from './view/context-gauge'
export { useDockClearance } from './view/dock-clearance'
export type { PermissionDockProps } from './view/permission-dock'
export {
  PromptInput,
  PromptInputBody,
  PromptInputEditor,
  type PromptInputHandle,
  PromptInputSubmit,
  PromptInputToolbar,
} from './view/prompt-input'
export { PromptQueue } from './view/prompt-queue'
export type { ControlsOpenRequest } from './view/session-controls'
export { SwarmToggle } from './view/swarm-toggle'

/* 输入框的独立 surface：没有自己的注册步骤，组件由 conversation 组合根挂载。 */
export default defineUiFeature({ id: 'composer', setup() {} })
