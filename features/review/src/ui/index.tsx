import {
  composerContextItems,
  turnChangesProviders,
  workspaceGitProviders,
} from '@poietica/feature-conversation/ui-api'
import { WorkspacesUiToken } from '@poietica/feature-workspaces/ui-api'
import { BannersToken, builtinPoints, defineUiFeature, LayoutToken } from '@poietica/ui-kernel'
import { FileDiff, GitCompareArrows } from 'lucide-react'
import { createTurnChangesApi } from './api'
import { ComposerBranchChip } from './composer-branch'
import { coreSessionOf } from './core-session'
import { BranchStatusItem, CodeReviewNavRow, CodeReviewSurface, ReviewPanel } from './surface'
import { createTurnChangesHolder, TurnChangesSource } from './turn-changes-source'
import { WorkspaceGitSource } from './workspace-git-source'

const PANEL_ID = 'review.panel'

/* 审查功能的 UI 装配。落点：sidebarSections（nav, order 25）「代码审查」；surfaces review.code；panels（right, order 10）
 * 「审查」—— 读活动工作区；statusItems（left, order 20）当前分支名；commands review.openChanges（Ctrl+Shift+G）/ review.commit。 */
export default defineUiFeature({
  id: 'review',
  dependsOn: ['conversation', 'platform', 'workspaces'],
  setup(ctx) {
    const layout = ctx.services.get(LayoutToken)
    const banners = ctx.services.get(BannersToken)
    const workspaces = ctx.services.get(WorkspacesUiToken)
    /* Core 的世代从装配那一刻算起：之后每次重启，开着的审查面板都要重发 git.watch（见 core-session.ts）。 */
    coreSessionOf(ctx)

    const report = (
      code: 'GIT_CHANGES_UNREADABLE' | 'GIT_REVIEW_ACTION_FAILED',
      context: { readonly cause: unknown },
    ): void => {
      if (code === 'GIT_CHANGES_UNREADABLE') {
        ctx.logger.warn('改动读不到', { error: String(context.cause) })
        return
      }
      ctx.logger.warn('git 动作失败', { error: String(context.cause) })
      banners.error(context.cause, '提交或分支操作失败')
    }

    ctx.contribute(builtinPoints.panels, {
      id: PANEL_ID,
      location: 'right',
      order: 10,
      title: '审查',
      icon: FileDiff,
      component: () => <ReviewPanel ctx={ctx} report={report} workspaces={workspaces} />,
    })

    /* 侧栏导航「代码审查」（order 25，落在「新建对话」与「自动化」之间）。正文还没写，页面先占位。 */
    ctx.contribute(builtinPoints.sidebarSections, {
      id: 'review.nav',
      order: 25,
      title: '代码审查',
      icon: GitCompareArrows,
      placement: 'nav',
      component: () => <CodeReviewNavRow />,
    })

    ctx.contribute(builtinPoints.surfaces, {
      id: 'review.code',
      title: '代码审查',
      component: () => <CodeReviewSurface ctx={ctx} workspaces={workspaces} />,
    })

    ctx.contribute(builtinPoints.statusItems, {
      id: 'review.branch',
      align: 'left',
      order: 20,
      component: () => <BranchStatusItem ctx={ctx} workspaces={workspaces} />,
    })

    /* 输入框下方那一行的分支 chip（composerContextItems）。conversation 不认识 git、review 也不该认识输入框，所以 review 把这一枚
     * 贡献到 conversation 的上下文栏。只有入口相位画它 —— 会话态那一行 legacy 里也没有。 */
    ctx.contribute(composerContextItems, {
      id: 'review.composerBranch',
      order: 10,
      component: () => <ComposerBranchChip />,
    })

    /* 状态面板「Git 工具」那一格的事实源。那一格住在 conversation，而事实属于 review；review 往贡献点里放一个 Provider。
     * **两处读的是同一个 store**，所以永远报同一组数。 */
    ctx.contribute(workspaceGitProviders, {
      id: 'review.workspaceGit',
      order: 10,
      component: ({ children }) => (
        <WorkspaceGitSource ctx={ctx} report={report}>
          {children}
        </WorkspaceGitSource>
      ),
    })

    /* 每轮回复下方那条「N 个文件已更改 / 撤销」的事实源。账本属于 review，conversation 只画那一条；
     * 与上面那一格同一形制。holder 挂在装配这一层：落账通知只有一处订阅，Core 重启时也由这里整体作废 ——
     * 组件里做不到，那一层随对话切换挂上卸下。 */
    const turnChangesGateway = createTurnChangesApi(ctx)
    const turnChanges = createTurnChangesHolder({ gateway: turnChangesGateway, logger: ctx.logger })
    const offTurnChanges = turnChanges.start()
    ctx.lifecycle.onCoreReady(() => {
      turnChanges.reset()
    })
    ctx.lifecycle.onDispose(() => {
      offTurnChanges()
      turnChanges.stop()
    })

    ctx.contribute(turnChangesProviders, {
      id: 'review.turnChanges',
      order: 10,
      component: ({ children }) => (
        <TurnChangesSource
          gateway={turnChangesGateway}
          holder={turnChanges}
          onFailure={(cause) => {
            banners.error(cause, '撤销失败')
          }}
        >
          {children}
        </TurnChangesSource>
      ),
    })

    const openChanges = (): void => {
      layout.openPanel('right', PANEL_ID)
    }
    ctx.contribute(builtinPoints.commands, {
      id: 'review.openChanges',
      title: '打开改动面板',
      category: 'Git',
      run: openChanges,
    })
    ctx.contribute(builtinPoints.keybindings, { command: 'review.openChanges', key: 'Ctrl+Shift+G' })
    ctx.contribute(builtinPoints.commands, {
      id: 'review.commit',
      title: '提交改动',
      category: 'Git',
      /* 这个命令只把面板打开、把焦点送到输入框，不替人提交。 */
      run: () => {
        openChanges()
        window.requestAnimationFrame(() => {
          document.querySelector<HTMLTextAreaElement>('textarea[name="commit-message"]')?.focus()
        })
      },
    })
  },
})
