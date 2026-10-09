import type { CoreModuleContext } from '@poietica/core-kernel'
import type { workspacesContract } from '../contract'
import type { WorkspacesApi } from './service'

type Ctx = CoreModuleContext<typeof workspacesContract>

/** 契约方法 → 服务调用（每个 handler 一行） */
export function registerHandlers(ctx: Ctx, service: WorkspacesApi): void {
  ctx.rpc.handle('workspaces.list', () => ({ workspaces: [...service.list()] }))
  ctx.rpc.handle('workspaces.add', ({ path }) => service.add(path))
  ctx.rpc.handle('workspaces.createScratch', () => service.createScratch())
  ctx.rpc.handle('workspaces.rename', ({ workspaceId, name }) => service.rename(workspaceId, name))
  ctx.rpc.handle('workspaces.remove', async ({ workspaceId }) => {
    await service.remove(workspaceId)
    return {}
  })
  ctx.rpc.handle('workspaces.touch', ({ workspaceId }) => {
    service.touch(workspaceId)
    return {}
  })
}
