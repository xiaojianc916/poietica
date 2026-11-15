import { defineCoreModule } from '@poietica/core-kernel'
import { SettingsServiceToken } from '@poietica/feature-settings/core-api'
import { agentSettingsContract } from '../contract'
import { createOmpSettingsProvider } from './provider'
import { hostSecretSettingsVault, restoreSecretSettings } from './secret-settings'
import { createAgentSettingsService } from './service'

export default defineCoreModule({
  id: 'agent-settings',
  contract: agentSettingsContract,
  dependsOn: ['settings'],
  async setup(ctx) {
    const vault = hostSecretSettingsVault(ctx.host)
    /* 在任何会话打开之前把凭据类设置注入引擎（ADR-008：Core 不持久化凭据） */
    await restoreSecretSettings({ vault, settings: ctx.agentRuntime.settings, logger: ctx.logger }).catch(
      (e: unknown) => {
        ctx.logger.error('secret settings restore failed', { error: String(e) })
      },
    )
    ctx.services.get(SettingsServiceToken).registerProvider(createOmpSettingsProvider(ctx.agentRuntime.settings))
    const service = createAgentSettingsService({
      vault,
      settings: ctx.agentRuntime.settings,
      groupOrder: ctx.agentRuntime.settings.groupOrder,
      emitChanged: (paths) => ctx.rpc.emit('agentSettings.changed', { paths: [...paths] }),
    })

    ctx.rpc.handle('agentSettings.catalog', () => service.catalog())
    ctx.rpc.handle('agentSettings.set', ({ path, value }) => service.set(path, value))
    ctx.rpc.handle('agentSettings.reset', ({ path }) => service.reset(path))
    ctx.rpc.handle('agentSettings.capabilities', () => service.capabilities())
    ctx.rpc.handle('agentSettings.setCapability', ({ name, enabled }) => service.setCapability(name, enabled))

    ctx.disposables.add(
      ctx.agentRuntime.settings.onDidChange((e) => {
        ctx.rpc.emit('agentSettings.changed', { paths: [...e.paths] })
      }),
    )
  },
})
