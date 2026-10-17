import { defineCoreModule } from '@poietica/core-kernel'
import { modelsContract } from '../contract'
import { LoginFlows } from './login-flows'
import { createModelsService } from './service'

export default defineCoreModule({
  id: 'models',
  contract: modelsContract,
  setup(ctx) {
    const service = createModelsService({
      models: ctx.engine.models,
      logger: ctx.logger,
      emitChanged: () => ctx.rpc.emit('models.changed', {}),
    })

    ctx.rpc.handle('models.providers', async () => ({ providers: await service.providers() }))
    /* 订阅登录：流程归 omp（AuthStorage.oauth.login），这里只做回调 ↔ 通知的翻译 */
    const logins = new LoginFlows({
      models: ctx.engine.models,
      logger: ctx.logger,
      emit: (loginId, event) => ctx.rpc.emit('models.loginEvent', { loginId, event }),
      emitChanged: () => ctx.rpc.emit('models.changed', {}),
    })
    ctx.disposables.add({ dispose: () => logins.dispose() })
    ctx.rpc.handle('models.loginProviders', async () => ({ providers: await ctx.engine.models.loginProviders() }))
    ctx.rpc.handle('models.startLogin', ({ providerId }) => ({ loginId: logins.start(providerId) }))
    ctx.rpc.handle('models.answerLogin', ({ loginId, promptId, value }) => {
      logins.answer(loginId, promptId, value)
      return {}
    })
    ctx.rpc.handle('models.cancelLogin', ({ loginId }) => {
      logins.cancel(loginId)
      return {}
    })
    ctx.rpc.handle('models.setApiKey', async ({ provider, apiKey }) => {
      await service.setApiKey(provider, apiKey)
      return {}
    })
    ctx.rpc.handle('models.clearApiKey', async ({ provider }) => {
      await service.clearApiKey(provider)
      return {}
    })
    ctx.rpc.handle('models.upsertCustomProvider', async (def) => {
      await service.upsertCustomProvider(def)
      return {}
    })
    ctx.rpc.handle('models.removeCustomProvider', async ({ providerId }) => {
      await service.removeCustomProvider(providerId)
      return {}
    })
    ctx.rpc.handle('models.catalog', async () => ({ models: await service.catalog() }))
    ctx.rpc.handle('models.setEnabled', async ({ model, enabled }) => {
      await service.setEnabled(model, enabled)
      return {}
    })
    ctx.rpc.handle('models.defaults', () => service.defaults())
    ctx.rpc.handle('models.roles', async () => ({ roles: await service.roles() }))
    ctx.rpc.handle('models.setRole', async ({ role, selector }) => {
      await service.setRole(role, selector)
      return {}
    })
    ctx.rpc.handle('models.setDefaults', async (patch) => {
      await service.setDefaults({
        ...(patch.model === undefined ? {} : { model: patch.model }),
        ...(patch.thinking === undefined ? {} : { thinking: patch.thinking }),
      })
      return {}
    })

    // omp 自己刷新目录时 UI 也能更新（两者都 emit，重复通知无害）。
    const changed = (): void => {
      ctx.rpc.emit('models.changed', {})
    }
    ctx.disposables.add(ctx.engine.models.onDidChange(changed))
    // 入口页写穿默认意图时模型页的「默认」标记也要跟着变：默认值变更单独一条事件（不让会话池换代）
    ctx.disposables.add(ctx.engine.models.onDidChangeDefaults(changed))
  },
})
