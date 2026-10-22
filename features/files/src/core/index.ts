import { defineCoreModule } from '@poietica/core-kernel'
import { type WorkspaceRemoved, WorkspacesServiceToken, workspaceRemoved } from '@poietica/feature-workspaces/core-api'
import { filesContract } from '../contract'
import { createFilesGit } from './git'
import { createFilesService } from './service'
import { createWatchSet, watchTree } from './watch'

export default defineCoreModule({
  id: 'files',
  contract: filesContract,
  dependsOn: ['workspaces'],
  setup(ctx) {
    const workspaces = ctx.services.get(WorkspacesServiceToken)
    /* 每次调用都问一遍：工作区被移走、目录被删之后自然报 workspaces.not_found / directory_missing。 */
    const rootOf = (workspaceId: string): string => workspaces.requireUsable(workspaceId).path
    const service = createFilesService({
      git: createFilesGit((what, cause) => {
        ctx.logger.warn('files git query failed', { what, error: String(cause) })
      }),
    })
    const watchers = createWatchSet({
      start: (root, onChange) =>
        watchTree(root, onChange, {
          onError: (error) => {
            ctx.logger.warn('files watch failed', { root, error: String(error) })
          },
        }),
      onChange: (workspaceId, root, paths) => {
        service.invalidate(root)
        ctx.rpc.emit('files.changed', { workspaceId, paths: paths === null ? null : [...paths] })
      },
    })
    ctx.disposables.add({ dispose: () => watchers.dispose() })
    ctx.lifecycle.onShutdown(() => watchers.dispose())
    ctx.disposables.add(
      ctx.events.on<WorkspaceRemoved>(workspaceRemoved, (e) => {
        watchers.forget(e.workspaceId)
        service.invalidate(e.path)
      }),
    )

    ctx.rpc.handle('files.list', (p) => service.list(rootOf(p.workspaceId), p.path))
    ctx.rpc.handle('files.read', (p) => service.read(rootOf(p.workspaceId), p.path))
    ctx.rpc.handle('files.locate', (p) => service.locate(rootOf(p.workspaceId), p.path))
    ctx.rpc.handle('files.search', (p) => service.search(rootOf(p.workspaceId), p.query, p.limit))
    ctx.rpc.handle('files.watch', (p) => {
      const targets = new Map<string, string>()
      for (const workspaceId of p.workspaceIds) {
        try {
          targets.set(workspaceId, rootOf(workspaceId))
        } catch (cause: unknown) {
          /* 界面手里的工作区可能刚被移走：这一个不看，其余照常。 */
          ctx.logger.warn('files watch skipped', { workspaceId, error: String(cause) })
        }
      }
      watchers.set(targets)
      return {}
    })
  },
})
