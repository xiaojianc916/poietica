/// <reference path="../../../../packages/design-system/src/css.d.ts" />

import { composerContextItems, workspaceGitProviders } from '@poietica/feature-conversation/ui-api'
import { WorkspacesUiToken } from '@poietica/feature-workspaces/ui-api'
import { builtinPoints, defineUiFeature, LayoutToken, ToastsToken } from '@poietica/ui-kernel'
import { FileDiff, GitCompareArrows } from 'lucide-react'
import { ComposerBranchChip } from './composer-branch'
import { BranchStatusItem, CodeReviewNavRow, CodeReviewSurface, ReviewPanel } from './surface'
import { WorkspaceGitSource } from './workspace-git-source'

const PANEL_ID = 'review.panel'

/* 审查功能的 UI 装配。落点：sidebarSections（nav, order 25）「代码审查」；surfaces review.code；panels（right, order 10）
 * 「审查」—— 读活动工作区；statusItems（left, order 20）当前分支名；commands review.openChanges（Ctrl+Shift+G）/ review.commit。 */
export default defineUiFeature({
  id: 'review',
  dependsOn: ['conversation', 'platform', 'workspaces'],
  setup(ctx) {
    const layout = ctx.services.get(LayoutToken)
    const toasts = ctx.services.get(ToastsToken)
    const workspaces = ctx.services.get(WorkspacesUiToken)

    const report = (
      code: 'GIT_CHANGES_UNREADABLE' | 'GIT_REVIEW_ACTION_FAILED',
      context: { readonly cause: unknown },
    ): void => {
      if (code === 'GIT_CHANGES_UNREADABLE') {
        ctx.logger.warn('改动读不到', { error: String(context.cause) })
        return
      }
      ctx.logger.warn('git 动作失败', { error: String(context.cause) })
      toasts.error(context.cause, '提交或分支操作失败')
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
