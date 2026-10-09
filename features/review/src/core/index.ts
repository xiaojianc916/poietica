import { defineCoreModule } from '@poietica/core-kernel'
import { type WorkspacesService, WorkspacesServiceToken } from '@poietica/feature-workspaces/core-api'
import { createGit } from '@poietica/git'
import { reviewContract } from '../contract'
import { createReviewService, type ReviewService } from './service'
import { createReviewWatcher, repositoryWatcher } from './watch'

export default defineCoreModule({
  id: 'review',
  contract: reviewContract,
  dependsOn: ['workspaces'],
  setup(ctx) {
    const workspaces = ctx.services.get(WorkspacesServiceToken) as WorkspacesService
    const service: ReviewService = createReviewService({
      gitFor: (cwd) => createGit({ cwd }),
      logger: ctx.logger,
    })
    const watcher = createReviewWatcher({
      start: repositoryWatcher((error) => {
        ctx.logger.warn('repository watch failed', { error: String(error) })
      }),
    })

    /* 工作区 id → 仓库路径；每次调用都问一遍，工作区被移走后自然报 workspaces.not_found */
    const pathOf = (workspaceId: string): string => workspaces.requireUsable(workspaceId).path

    ctx.disposables.add({ dispose: () => watcher.dispose() })
    ctx.lifecycle.onShutdown(() => watcher.dispose())

    ctx.rpc.handle('git.status', (p) => service.status(pathOf(p.workspaceId)))
    ctx.rpc.handle('git.branches', (p) => service.branches(pathOf(p.workspaceId)))
    ctx.rpc.handle('git.switchBranch', (p) => service.switchBranch(pathOf(p.workspaceId), p.branch))
    ctx.rpc.handle('git.createBranch', (p) => service.createBranch(pathOf(p.workspaceId), p.branch, p.from ?? null))
    ctx.rpc.handle('git.review', (p) =>
      service.review(pathOf(p.workspaceId), p.base).then((files) => ({ files: [...files] })),
    )
    ctx.rpc.handle('git.filePatch', (p) =>
      service.filePatch(pathOf(p.workspaceId), p.path, p.base).then((patch) => ({ patch })),
    )
    ctx.rpc.handle('git.stage', (p) => service.stage(pathOf(p.workspaceId), p.paths))
    ctx.rpc.handle('git.unstage', (p) => service.unstage(pathOf(p.workspaceId), p.paths))
    ctx.rpc.handle('git.commit', (p) => service.commit(pathOf(p.workspaceId), p.message, p.stageAll))
    ctx.rpc.handle('git.watch', (p) => {
      const path = pathOf(p.workspaceId)
      watcher.watch(path, () => ctx.rpc.emit('git.changed', { workspaceId: p.workspaceId }))
      return {}
    })
    ctx.rpc.handle('git.unwatch', (p) => {
      try {
        watcher.unwatch(pathOf(p.workspaceId))
      } catch {
        /* 工作区已被移除：监听也随它一起没了，不算失败 */
      }
      return {}
    })
  },
})
