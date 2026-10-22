import { defineCoreModule } from '@poietica/core-kernel'
import { type WorkspaceRemoved, WorkspacesServiceToken, workspaceRemoved } from '@poietica/feature-workspaces/core-api'
import { createGit } from '@poietica/git'
import { reviewContract } from '../contract'
import { createGithubService, type GithubService } from './pr'
import { createReviewService, type ReviewService } from './service'
import { createReviewWatcher, repositoryWatcher } from './watch'

export default defineCoreModule({
  id: 'review',
  contract: reviewContract,
  dependsOn: ['workspaces'],
  setup(ctx) {
    const workspaces = ctx.services.get(WorkspacesServiceToken)
    const service: ReviewService = createReviewService({
      gitFor: (cwd) => createGit({ cwd }),
      logger: ctx.logger,
    })
    const github: GithubService = createGithubService({
      logger: ctx.logger,
      /* 仓库从本地远端认（不问网络）；不是仓库时 git 非 0 退出，按「没有远端」处理。 */
      remotes: (cwd) =>
        createGit({ cwd })
          .run(['remote', '-v'], { okExitCodes: [0, 128], timeoutMs: 10_000 })
          .then((result) => (result.exitCode === 0 ? result.stdout : '')),
    })
    const watcher = createReviewWatcher({
      start: repositoryWatcher((error) => {
        ctx.logger.warn('repository watch failed', { error: String(error) })
      }),
      onChange: (workspaceId) => {
        ctx.rpc.emit('git.changed', { workspaceId })
      },
    })

    /* 每次调用都问一遍，工作区被移走后自然报 workspaces.not_found。 */
    const pathOf = (workspaceId: string): string => workspaces.requireUsable(workspaceId).path

    ctx.disposables.add({ dispose: () => watcher.dispose() })
    ctx.lifecycle.onShutdown(() => watcher.dispose())
    /* 工作区被移走：它的监听一并停掉（界面那边的 unwatch 可能永远不会来了）。 */
    ctx.disposables.add(
      ctx.events.on<WorkspaceRemoved>(workspaceRemoved, (e) => {
        watcher.forget(e.workspaceId)
      }),
    )

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
      watcher.watch(p.workspaceId, pathOf(p.workspaceId))
      return {}
    })
    /* 代码审查页那一侧：读 GitHub 上的 pull request，以及三种写操作。 */
    ctx.rpc.handle('github.availability', () => github.availability())
    ctx.rpc.handle('github.repository', (p) =>
      github.repository(pathOf(p.workspaceId)).then((repository) => ({ repository })),
    )
    ctx.rpc.handle('github.pullRequests', (p) =>
      github.pullRequests(pathOf(p.workspaceId), p.includeClosed ?? false).then((page) => ({
        repository: page.repository,
        pulls: [...page.pulls],
      })),
    )
    ctx.rpc.handle('github.pullRequest', (p) =>
      github.pullRequest(pathOf(p.workspaceId), p.number).then((pull) => ({ pull })),
    )
    ctx.rpc.handle('github.comments', (p) =>
      github.comments(pathOf(p.workspaceId), p.number).then((comments) => ({ comments: [...comments] })),
    )
    ctx.rpc.handle('github.comment', (p) =>
      github.comment(pathOf(p.workspaceId), p.number, p.body).then((comment) => ({ comment })),
    )
    ctx.rpc.handle('github.setDraft', (p) => github.setDraft(pathOf(p.workspaceId), p.number, p.draft).then(() => ({})))
    ctx.rpc.handle('github.mergePullRequest', (p) =>
      github.merge(pathOf(p.workspaceId), p.number, p.method).then(() => ({})),
    )

    /* 按 workspaceId 摘，不再问路径：工作区已被移走时也摘得掉（移走那一刻 forget 已经停过，这里是空操作）。 */
    ctx.rpc.handle('git.unwatch', (p) => {
      watcher.unwatch(p.workspaceId)
      return {}
    })
  },
})
