/// <reference path="../../../../packages/design-system/src/css.d.ts" />

import { composerContextItems, workspaceGitProviders } from '@poietica/feature-conversation/ui-api'
import { type WorkspacesUi, WorkspacesUiToken } from '@poietica/feature-workspaces/ui-api'
import { builtinPoints, defineUiFeature, type LayoutService, LayoutToken, ToastsToken } from '@poietica/ui-kernel'
import { FileDiff } from 'lucide-react'
import { ComposerBranchChip } from './composer-branch'
import { BranchStatusItem, ReviewPanel } from './surface'
import { WorkspaceGitSource } from './workspace-git-source'

const PANEL_ID = 'review.panel'

/*
 * 审查功能的 UI 装配（07 页 §10E）。
 *
 * 落点与它们的读法：
 *   panels（right, order 10）“审查”            —— 读活动工作区
 *   statusItems（left, order 20）当前分支名      —— 读活动工作区
 *   commands review.openChanges（Ctrl+Shift+G）/ review.commit
 *
 * 07 页 §10E 的第三处落点 —— conversation 的 threadHeaderItems“N 个文件改动”
 * 按钮 —— **产品负责人 2026-10-07 决定删除**（连同它的悬停气泡，见 refactor-log
 * 偏差 #49）。打开审查面板改由命令与右坞启动器承担，贡献点本身留在 conversation。
 *
 * 「报告失败」这一格：legacy 走应用级管线（notice/problem-presentation）；新架构里
 * 对应的是 UI 日志 + toast。审查面只把两件事报告出来（读不到 / 动作失败），
 * 呈现交给内核服务决定（守则 7：日志只用 ctx.logger）。
 */
export default defineUiFeature({
  id: 'review',
  dependsOn: ['conversation', 'workspaces'],
  setup(ctx) {
    const layout = ctx.services.get(LayoutToken) as LayoutService
    const toasts = ctx.services.get(ToastsToken)
    const workspaces = ctx.services.get(WorkspacesUiToken) as WorkspacesUi

    const report = (
      code: 'GIT_CHANGES_UNREADABLE' | 'GIT_REVIEW_ACTION_FAILED',
      context: { readonly cause: unknown },
    ): void => {
      if (code === 'GIT_CHANGES_UNREADABLE') {
        /* 读不到变更清单：审查那一格自己说读取失败（与 legacy 的 problem-presentation 同义）。 */
        ctx.logger.warn('改动读不到', { error: String(context.cause) })
        return
      }
      ctx.logger.warn('git 动作失败', { error: String(context.cause) })
      toasts.error(context.cause, '提交或分支操作失败')
    }

    /*
     * 面板名取 legacy pane 的 label「审查」（auxiliary-panel-store.ts 的 AUXILIARY_LAUNCHER）：
     * 启动器与坞标签条都读同一个 title，所以这里改一处两处都对。
     */
    ctx.contribute(builtinPoints.panels, {
      id: PANEL_ID,
      location: 'right',
      order: 10,
      title: '审查',
      icon: FileDiff,
      component: () => <ReviewPanel ctx={ctx} report={report} workspaces={workspaces} />,
    })

    ctx.contribute(builtinPoints.statusItems, {
      id: 'review.branch',
      align: 'left',
      order: 20,
      component: () => <BranchStatusItem ctx={ctx} workspaces={workspaces} />,
    })

    /*
     * 输入框下方那一行的分支 chip（07 页 §5E 的 composerContextItems）。
     *
     * legacy 里它由宿主直接交给 AssistantSurface（`workspace-git-status.ts` 的 picker），
     * 新架构里 conversation 不认识 git、review 也不该认识输入框，所以 review 把这一枚
     * 贡献到 conversation 的上下文栏（03 页 §4.4）。只有入口相位画它 —— 会话态那一行
     * 整条在 legacy 里也没有（`workspace` 与 `git` 只在 isEntry 时交给表面）。
     */
    ctx.contribute(composerContextItems, {
      id: 'review.composerBranch',
      order: 10,
      component: () => <ComposerBranchChip />,
    })

    /*
     * 状态面板「Git 工具」那一格的事实源（03 页 §4.4 的跨功能扩展）。
     *
     * 那一格住在 conversation（它画的是任务浮层的排版），而它读的事实属于 review
     * （分支、改动清单、+N/-M）。conversation 不认识 git、review 也不该认识任务面板，
     * 所以 review 往 conversation 的贡献点里放一个 Provider —— 与上面那枚分支 chip
     * 同一条理由、同一份数据。**两处读的是同一个 store**（review-store-holder），
     * 所以审查面板与浮层永远报同一组数（legacy 各建一份，是老毛病）。
     */
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
      /*
       * 提交要一条说明，而说明是用户写进提交框的：这个命令只把面板打开、把焦点送到
       * 输入框，不替人提交（与 legacy 的入口语义一致）。
       */
      run: () => {
        openChanges()
        window.requestAnimationFrame(() => {
          document.querySelector<HTMLTextAreaElement>('textarea[name="commit-message"]')?.focus()
        })
      },
    })
  },
})
