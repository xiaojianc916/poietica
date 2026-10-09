import { defineCoreModule } from '@poietica/core-kernel'
import { agentSettingsContract } from '../contract'
import { createAgentSettingsService } from './service'

export default defineCoreModule({
  id: 'agent-settings',
  contract: agentSettingsContract,
  setup(ctx) {
    const service = createAgentSettingsService({
      settings: ctx.engine.settings,
      /* 端口交出的就是 group 键的序列（与 descriptor.group 同源），这里原样转发。 */
      groupOrder: ctx.engine.settings.groupOrder,
      emitChanged: (paths) => ctx.rpc.emit('agentSettings.changed', { paths: [...paths] }),
    })

    ctx.rpc.handle('agentSettings.catalog', () => service.catalog())
    ctx.rpc.handle('agentSettings.set', ({ path, value }) => service.set(path, value))
    ctx.rpc.handle('agentSettings.reset', ({ path }) => service.reset(path))
    ctx.rpc.handle('agentSettings.capabilities', () => service.capabilities())
    ctx.rpc.handle('agentSettings.setCapability', ({ name, enabled }) => service.setCapability(name, enabled))

    ctx.disposables.add(
      ctx.engine.settings.onDidChange((e) => {
        ctx.rpc.emit('agentSettings.changed', { paths: [...e.paths] })
      }),
    )
  },
})
