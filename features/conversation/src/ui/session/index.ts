/*
 * session 区：会话的装配点（store 束、端口注册表、会话可调项、通知）。区与区之间只能经本文件互相引用。
 */

export { ActiveOwner } from './active-owner'
export {
  hiddenModelsOf,
  PLAN_CONTROL_ID,
  PLAN_DISABLED,
  PLAN_ENABLED,
  postureOfControl,
  sessionConfigControlsOf,
  withoutHiddenModels,
} from './configuration/control-shapes'
export { createPostureIntent, type PostureIntent } from './configuration/posture-intent'
export { SessionControlsContext, useOptionalThreadGoal } from './configuration/session-controls-context'
export { createSessionRegistry, type SessionRegistry } from './session-registry'
export { ArchivedChatsPage } from './settings/archived-page'
export { type ComposerApi, type ConversationStores, createStores } from './stores'
export { createThreadEntry, type ThreadEntry } from './thread-entry'
