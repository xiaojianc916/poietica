import { defineCoreModule } from '@poietica/core-kernel'
import { ConversationServiceToken, threadRemoved, turnFileChanged } from '@poietica/feature-conversation/core-api'
import { type WorkspaceRemoved, WorkspacesServiceToken, workspaceRemoved } from '@poietica/feature-workspaces/core-api'
import { AppError } from '@poietica/foundation'
import { createGit } from '@poietica/git'
import { reviewContract } from '../contract'
import { reviewErrors } from '../contract/errors'
import { migrations } from './migrations'
import { createGithubService, type GithubService } from './pr'
import { createTurnRewind } from './rewind'
import { createReviewService, type ReviewService } from './service'
import { createTurnFileLedger } from './turn-files'
import { createTurnFilesRepository } from './turn-files-repository'
import { createReviewWatcher, repositoryWatcher } from './watch'

export default defineCoreModule({
  id: 'review',
  contract: reviewContract,
  /* conversation：一轮改过哪些文件是它发出来的（turnFileChanged），线程 → 工作区也从它问。 */
  dependsOn: ['workspaces', 'conversation'],
  migrations,
  setup(ctx) {
    const workspaces = ctx.services.get(WorkspacesServiceToken)
    const conversation = ctx.services.get(ConversationServiceToken)
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

    /* 一轮文件改动的账：只从引擎写盘那一刻的事实来，撤销时按账退回工作区。 */
    const rewind = createTurnRewind({
      repo: createTurnFilesRepository(ctx.db),
      logger: ctx.logger,
      emitChanged: (threadId) => {
        ctx.rpc.emit('review.turnChangesChanged', { threadId })
      },
    })
    const ledger = createTurnFileLedger({
      rewind,
      logger: ctx.logger,
      /* 线程已被删时 get 回 null（那时这一笔没有主人，丢弃）。 */
      workspaceIdOf: (threadId) => conversation.get(threadId)?.workspaceId ?? null,
      pathOf,
    })

    ctx.disposables.add({ dispose: () => watcher.dispose() })
    ctx.lifecycle.onShutdown(() => watcher.dispose())
    /* 工作区被移走：它的监听一并停掉（界面那边的 unwatch 可能永远不会来了）。 */
    ctx.disposables.add(
      ctx.events.on<WorkspaceRemoved>(workspaceRemoved, (e) => {
        watcher.forget(e.workspaceId)
      }),
    )
    ctx.disposables.add(ctx.events.on(turnFileChanged, (fact) => ledger.record(fact)))
    ctx.disposables.add(ctx.events.on(threadRemoved, ({ threadId }) => rewind.forgetThread(threadId)))

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

    /* 回复下方那条「N 个文件已更改 / 撤销」：按 threadId 寻址，工作区路径从线程上问。 */
    const rootOfThread = (threadId: string): string => {
      const thread = conversation.get(threadId)
      if (thread === null) {
        throw new AppError(reviewErrors.rewind_not_available, '这条对话已经不在了', { threadId })
      }
      return pathOf(thread.workspaceId)
    }
    ctx.rpc.handle('review.turnChanges', (p) => {
      const thread = conversation.get(p.threadId)
      /* 线程已删：没有账可报（不是错误 —— 界面刚收到 threadRemoved 时可能还问一次）。 */
      if (thread === null) return { turns: [] }
      return rewind.list(p.threadId, pathOf(thread.workspaceId))
    })
    ctx.rpc.handle('review.previewTurnRewind', (p) => rewind.preview(p.threadId, p.turn, rootOfThread(p.threadId)))
    ctx.rpc.handle('review.applyTurnRewind', (p) => rewind.apply(p.threadId, p.turn, rootOfThread(p.threadId)))
    /* 右坞那一格 diff：账本里的两半正文（不读磁盘 —— 读回来的是写完之后的样子）。 */
    ctx.rpc.handle('review.turnFilePatch', (p) => rewind.patch(p.threadId, p.turn, rootOfThread(p.threadId), p.path))

    /* 按 workspaceId 摘，不再问路径：工作区已被移走时也摘得掉（移走那一刻 forget 已经停过，这里是空操作）。 */
    ctx.rpc.handle('git.unwatch', (p) => {
      watcher.unwatch(p.workspaceId)
      return {}
    })
  },
})
