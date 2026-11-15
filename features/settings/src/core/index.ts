import { defineCoreModule } from '@poietica/core-kernel'
import { settingsContract } from '../contract'
import { SettingsServiceToken } from '../core-api'
import { migrations } from './migrations'
import { createSettingsService } from './service'

export default defineCoreModule({
  id: 'settings',
  contract: settingsContract,
  migrations,
  setup(ctx) {
    const service = createSettingsService({ db: ctx.db, clock: ctx.clock })
    ctx.services.provide(SettingsServiceToken, service)
    ctx.rpc.handle('settings.describe', async (context) => [...(await service.describeAll(context))])
    ctx.rpc.handle('settings.set', async (input) => {
      await service.write(input)
      return [...(await service.describeAll())]
    })
  },
})
