import { defineCoreModule } from '@poietica/core-kernel'
import { SettingsServiceToken } from '@poietica/feature-settings/core-api'
import { createPreferencesProvider } from './provider'

/** preferences 的 Core 半边：把 Host 的 JSON 设置接进统一注册表，值仍由 Host 持有。 */
export default defineCoreModule({
  id: 'preferences',
  kind: 'domain',
  dependsOn: ['settings'],
  setup(ctx) {
    ctx.services.get(SettingsServiceToken).registerProvider(createPreferencesProvider(ctx.host))
  },
})
