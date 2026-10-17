import { platformContract } from '@poietica/feature-platform/contract'
import { preferencesContract } from '@poietica/feature-preferences/contract'
import { PreferencesToken } from '@poietica/feature-preferences/ui-api'
import { type WorkspacesUi, WorkspacesUiToken } from '@poietica/feature-workspaces/ui-api'
import {
  type DialogService,
  DialogsToken,
  type LayoutService,
  LayoutToken,
  type NavigationService,
  NavigationToken,
  type ToastService,
  ToastsToken,
  type UiFeatureContext,
} from '@poietica/ui-kernel'
import { createConversationApi } from '../api'
import { createEntryDefaults } from '../home'
import { type ConversationStores, createStores, hiddenModelsOf } from '../session'
import { createPostureIntent } from '../session/configuration/posture-intent'
import { createSessionRegistry, type SessionRegistry } from '../session/session-registry'
import { TranscriptStore } from '../timeline/model/transcript-store'

/* 装配的底座：RPC 封装、内核服务、四个 store、转录 store 与会话端口注册表。后面的 actions / subscriptions / contributions / commands / services 各自收一份本对象。 */

export function createConversationSetup(ctx: UiFeatureContext) {
  const api = createConversationApi(ctx)
  const platform = ctx.rpc(platformContract)
  /* 批准方式的持久意图写在 preferences 功能的 uiState 里（`conversation.permissionPosture`，契约里已登记的键），conversation 的 `dependsOn` 本来就含 'preferences'。 */
  const preferences = ctx.rpc(preferencesContract)
  const posture = createPostureIntent({
    read: () => preferences.call('uiState.get', { key: 'conversation.permissionPosture' }).then((r) => r.value),
    write: (value) =>
      preferences.call('uiState.set', { key: 'conversation.permissionPosture', value }).then(() => undefined),
    report: (cause) => {
      ctx.logger.warn('permission posture memory failed', { error: String(cause) })
    },
  })
  const navigation = ctx.services.get(NavigationToken) as NavigationService
  const dialogs = ctx.services.get(DialogsToken) as DialogService
  const toasts = ctx.services.get(ToastsToken) as ToastService
  const prefs = ctx.services.get(PreferencesToken)
  const workspaces = ctx.services.get(WorkspacesUiToken) as WorkspacesUi

  const stores: ConversationStores = createStores(api)
  /* 入口页的模型 / 档位写穿「新对话默认」意图；hidden 只约束 Core「只改档位时解出显示的模型」那一步的兜底 */
  const entryDefaults = createEntryDefaults({
    composer: stores.composer,
    write: (choice) => api.setDraftDefaults({ ...choice, hidden: hiddenModelsOf(prefs.current()) }),
    report: (cause) => {
      ctx.logger.warn('entry default selection write failed', { error: String(cause) })
    },
  })

  /* 转录 store：副本、队列、待答都在里面，数据来源由 session-port 接到 RPC 上；它经 Context 交给组件树。 */
  let sessions: SessionRegistry
  const transcripts = new TranscriptStore({ sessions: (threadId) => sessions.port(threadId) })
  /* 快照里的「提交行」也从这里转给转录 store；回调写成经 transcripts 转发，所以两台要按这个顺序建。 */
  sessions = createSessionRegistry({
    api,
    onSubmissions: (threadId, rows) => {
      for (const row of rows) transcripts.upsertSubmission(threadId, row)
    },
  })
  const layout = ctx.services.get(LayoutToken) as LayoutService

  return {
    api,
    ctx,
    dialogs,
    entryDefaults,
    layout,
    navigation,
    platform,
    posture,
    preferences,
    prefs,
    sessions,
    stores,
    toasts,
    transcripts,
    workspaces,
  }
}

/* 形状由工厂推出来，不手写一遍：手写的泛型一旦和 ctx.rpc 实际交回的类型对不上，参数就静默塌成 never —— 报错点全在调用方。 */
export type ConversationSetup = ReturnType<typeof createConversationSetup>
