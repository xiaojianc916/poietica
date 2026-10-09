import fs from 'node:fs'
import { defineCoreModule } from '@poietica/core-kernel'
import { ensureDir } from '@poietica/fs-kit'
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
      scratchDir: ctx.layout.scratchDir,
      clock: ctx.clock,
      logger: ctx.logger,
      emitChanged: () => {
        ctx.rpc.emit('workspaces.changed', { workspaces: [...service.list()] })
      },
      emitRemoved: (e: WorkspaceRemoved) => {
        ctx.events.emit(workspaceRemoved, e)
      },
      fs: {
        isDirectory: (p) => fs.existsSync(p) && fs.statSync(p).isDirectory(),
        mkdir: (p) => ensureDir(p),
        exists: (p) => fs.existsSync(p),
      },
    })

    registerHandlers(ctx, service)
    ctx.services.provide(WorkspacesServiceToken, {
      get: service.get,
      requireUsable: service.requireUsable,
      list: service.list,
    })

    // scratchDir 由 createScratch 的第一次写入创建（08 页 §1 的“谁创建目录”表：第一次写入时 ensureDir）
  },
})
