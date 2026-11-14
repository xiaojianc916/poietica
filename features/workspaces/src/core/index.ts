import fs from 'node:fs'
import { defineCoreModule } from '@poietica/core-kernel'
import { workspacesContract } from '../contract'
import {
  WORKSPACE_REMOVED_TOPIC,
  type WorkspaceRemoved,
  WorkspacesServiceToken,
  WriteLeaseServiceToken,
} from '../core-api'
import { registerHandlers } from './handlers'
import { createWriteLeaseService } from './lease'
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
      transaction: (fn) => ctx.db.transaction(fn),
      onRemoved: (e: WorkspaceRemoved) => {
        ctx.outbox.enqueue({
          topic: WORKSPACE_REMOVED_TOPIC,
          payload: e,
          idempotencyKey: e.workspaceId,
        })
      },
      fs: {
        isDirectory: (p) => fs.statSync(p, { throwIfNoEntry: false })?.isDirectory() ?? false,
      },
    })

    ctx.services.provide(WriteLeaseServiceToken, createWriteLeaseService({ clock: ctx.clock }))
    registerHandlers(ctx, service)
    ctx.services.provide(WorkspacesServiceToken, {
      get: service.get,
      requireUsable: service.requireUsable,
      list: service.list,
    })
  },
})
