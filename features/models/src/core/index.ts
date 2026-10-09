import { defineCoreModule } from '@poietica/core-kernel'
import { modelsContract } from '../contract'
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
    ctx.rpc.handle('models.setDefaults', async (patch) => {
      await service.setDefaults({
        ...(patch.model === undefined ? {} : { model: patch.model }),
        ...(patch.thinking === undefined ? {} : { thinking: patch.thinking }),
      })
      return {}
    })

    // omp 自己刷新目录时 UI 也能更新（07 页 §6C：两者都 emit，重复通知无害）
    ctx.disposables.add(
      ctx.engine.models.onDidChange(() => {
        ctx.rpc.emit('models.changed', {})
      }),
    )
  },
})
