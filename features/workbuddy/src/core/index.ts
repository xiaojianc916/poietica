import { defineCoreModule } from '@poietica/core-kernel'
import { platformContract } from '@poietica/feature-platform/contract'
import { workbuddyContract } from '../contract'
import { migrations } from './migrations'
import { createWorkBuddyRepository } from './repository'
import { createWorkBuddyService } from './service'

export default defineCoreModule({
  id: 'workbuddy',
  contract: workbuddyContract,
  migrations,
  setup(ctx) {
    const repository = createWorkBuddyRepository(ctx.db)
    const service = createWorkBuddyService({
      repository,
      models: ctx.engine.models,
      logger: ctx.logger,
      now: () => ctx.clock.now(),
      openExternal: async (url) => {
        await ctx.host.call(platformContract, 'shell.openExternal', { url })
      },
      emitChanged: () => ctx.rpc.emit('workbuddy.changed', {}),
      emitLogin: (event) => ctx.rpc.emit('workbuddy.loginEvent', event),
    })

    ctx.rpc.handle('workbuddy.snapshot', () => service.snapshot())
    ctx.rpc.handle('workbuddy.startBrowserLogin', (params) => service.startBrowserLogin(params.accountId))
    ctx.rpc.handle('workbuddy.cancelLogin', (params) => {
      service.cancelLogin(params.loginId)
      return {}
    })
    ctx.rpc.handle('workbuddy.addApiKey', (params) => service.addApiKey(params.apiKey))
    ctx.rpc.handle('workbuddy.removeAccount', async (params) => {
      await service.removeAccount(params.accountId)
      return {}
    })
    ctx.rpc.handle('workbuddy.setPreferred', (params) => {
      service.setPreferred(params.accountId)
      return {}
    })
    ctx.rpc.handle('workbuddy.refreshUsage', (params) => service.refreshUsage(params.accountId))
    ctx.rpc.handle('workbuddy.checkin', (params) => service.checkin(params.accountId))
    ctx.rpc.handle('workbuddy.setEnabled', (params) => service.setEnabled(params.enabled))
    ctx.rpc.handle('workbuddy.setAutoCheckin', (params) => service.setAutoCheckin(params.enabled))
    ctx.rpc.handle('workbuddy.repairProvider', () => service.repairProvider())

    ctx.lifecycle.onReady(async () => {
      await service.start()
    })
    ctx.lifecycle.onShutdown(() => {
      service.dispose()
    })
  },
})
