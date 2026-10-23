import { platformContract } from '@poietica/feature-platform/contract'
import { PreferencesToken } from '@poietica/feature-preferences/ui-api'
import { WorkspacesUiToken } from '@poietica/feature-workspaces/ui-api'
import { BannersToken, DialogsToken, LayoutToken, NavigationToken, type UiFeatureContext } from '@poietica/ui-kernel'
import { createConversationApi } from '../api'
import { createLiveComposers } from '../composer/live-composers'
import { createSideStore } from '../composer/side-store'
import { createEntryDefaults } from '../home'
import { type ConversationStores, createStores, hiddenModelsOf } from '../session'
import { createPostureIntent, storedPostureOf } from '../session/configuration/posture-intent'
import { createSessionRegistry, type SessionRegistry } from '../session/session-registry'
import { TranscriptStore } from '../timeline/model/transcript-store'
import { SubagentTabsStore } from '../timeline/subagent-tabs'

/* 装配的底座：RPC 封装、内核服务、四个 store、转录 store 与会话端口注册表。后面的 actions / subscriptions / contributions / commands / services 各自收一份本对象。 */

export function createConversationSetup(ctx: UiFeatureContext) {
  const api = createConversationApi(ctx)
  const platform = ctx.rpc(platformContract)
  const prefs = ctx.services.get(PreferencesToken)
  /*
   * 批准方式的持久意图写在 preferences 功能的 uiState 里（`conversation.permissionPosture`，契约 UI_STATE_RESTORE 里登记为 setup 阶段），
   * conversation 的 `dependsOn` 本来就含 'preferences'。setup 里就读：以前排在首次 onCoreReady 里，冷启动这几秒入口页按默认档画。
   * 读失败按「没有意图」处置（release），之后照常写回。
   */
  const posture = createPostureIntent()
  const postureSlot = prefs.uiStateSlot({
    key: 'conversation.permissionPosture',
    parse: storedPostureOf,
    restore: (value) => posture.restore(value),
    snapshot: () => posture.read() ?? null,
    subscribe: posture.subscribe,
    readFailure: 'release',
    report: (cause, op) => {
      ctx.logger.warn('permission posture memory failed', { op, error: String(cause) })
    },
  })
  ctx.lifecycle.onDispose(postureSlot.dispose)
  const navigation = ctx.services.get(NavigationToken)
  const dialogs = ctx.services.get(DialogsToken)
  const banners = ctx.services.get(BannersToken)
  const workspaces = ctx.services.get(WorkspacesUiToken)

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
  const layout = ctx.services.get(LayoutToken)
  /* 右坞「子代理」组的标签账：按对话号分账，由线程表面（打开）与右坞（选中 / 关闭）共用。 */
  const subagentTabs = new SubagentTabsStore()
  /* 右坞「辅助对话」的账（侧边提问的话题表）：按对话号分账，数据只来自 side.* */
  const side = createSideStore(api)
  /* 屏幕上正在编辑的对话输入框：辅助对话「放进输入框」与 ConversationUiToken.composerOf 都从这里找那一格 */
  const liveComposers = createLiveComposers()

  return {
    api,
    ctx,
    dialogs,
    entryDefaults,
    layout,
    liveComposers,
    navigation,
    platform,
    posture,
    prefs,
    sessions,
    side,
    stores,
    subagentTabs,
    banners,
    transcripts,
    workspaces,
  }
}

/* 形状由工厂推出来，不手写一遍：手写的泛型一旦和 ctx.rpc 实际交回的类型对不上，参数就静默塌成 never —— 报错点全在调用方。 */
export type ConversationSetup = ReturnType<typeof createConversationSetup>
