import fs from 'node:fs'
import { defineCoreModule } from '@poietica/core-kernel'
import { workspacesContract } from '../contract'
import { type WorkspaceRemoved, WorkspacesServiceToken, workspaceRemoved } from '../core-api'
import { registerHandlers } from './handlers'
import { migrations } from './migrations'
import { createWorkspacesRepository } from './repository'
import { createWorkspacesService } from './service'

export default defineCoreModule({
  id: 'workspaces',
  contract: workspacesContract,
  migrations,
  setup(ctx) {
    const service = createWorkspacesService({
      repo: createWorkspacesRepository(ctx.db),
      clock: ctx.clock,
      emitChanged: () => {
        ctx.rpc.emit('workspaces.changed', { workspaces: [...service.list()] })
      },
      emitRemoved: (e: WorkspaceRemoved) => {
        ctx.events.emit(workspaceRemoved, e)
      },
      fs: {
        isDirectory: (p) => fs.statSync(p, { throwIfNoEntry: false })?.isDirectory() ?? false,
      },
    })

    registerHandlers(ctx, service)
    ctx.services.provide(WorkspacesServiceToken, {
      get: service.get,
      requireUsable: service.requireUsable,
      list: service.list,
    })
  },
})
