import { defineCoreModule } from '@poietica/core-kernel'
import {
  ConversationServiceToken,
  TurnContextRegistryToken,
  threadRemoved,
} from '@poietica/feature-conversation/core-api'
import { AppError } from '@poietica/foundation'
import { intelligentUiContract, intelligentUiErrors } from '../contract'
import { migrations } from './migrations'
import { createStatesRepo } from './repo'
import { stateContextProvider } from './state-context'
import { registerIntelligentUiTools } from './tool'

/**
 * intelligent-ui 的 Core 半边：
 * - 给 agent 注册 intelligent_ui 与 intelligent_ui_guide（工具集在全部 setup 之后冻结，所以必须在 setup 里注册）；
 * - 界面状态的读写（intelligentUi.getState / setState）；
 * - 向 conversation 的轮次上下文登记处交「上次之后变过的 model / tweaks 状态」，下一句话随之交给模型；
 * - 线程删除时清掉它的全部状态（threadRemoved；启动时再对一次账）。
 */
export default defineCoreModule({
  id: 'intelligent-ui',
  contract: intelligentUiContract,
  dependsOn: ['conversation'],
  migrations,
  setup(ctx) {
    registerIntelligentUiTools({ tools: ctx.agentTools })
    const repo = createStatesRepo(ctx.db)
    const conversation = ctx.services.get(ConversationServiceToken)

    ctx.rpc.handle('intelligentUi.getState', ({ threadId, callId }) => {
      const row = repo.get(threadId, callId)
      return { state: row === null ? null : { model: row.modelJson, view: row.viewJson, tweaks: row.tweaksJson } }
    })
    ctx.rpc.handle('intelligentUi.setState', (p) => {
      /* 线程已删：写进去就是一行永远没人清的孤账 */
      if (conversation.get(p.threadId) === null) {
        throw new AppError(intelligentUiErrors.thread_not_found, `对话不存在：${p.threadId}`)
      }
      repo.put({
        threadId: p.threadId,
        callId: p.callId,
        title: p.title,
        modelJson: p.model,
        viewJson: p.view,
        tweaksJson: p.tweaks,
        at: ctx.clock.now(),
      })
      return {}
    })

    ctx.disposables.add(ctx.services.get(TurnContextRegistryToken).register(stateContextProvider(repo)))
    ctx.disposables.add(ctx.events.on(threadRemoved, ({ threadId }) => repo.removeThread(threadId)))
    /* 进程内事件会丢（Core 在删线程与发事件之间崩掉）：启动时对一次账，删掉已经不存在的线程留下的行 */
    ctx.lifecycle.onReady(() => {
      for (const threadId of repo.threadIds()) {
        if (conversation.get(threadId) === null) repo.removeThread(threadId)
      }
    })
  },
})
