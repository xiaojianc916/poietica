import { Prose } from '@poietica/design-system/prose'
import { type ConversationUi, ConversationUiToken } from '@poietica/feature-conversation/ui-api'
import type { WorkspacesUi } from '@poietica/feature-workspaces/ui-api'
import { AppError } from '@poietica/foundation'
import {
  type BannerService,
  BannersToken,
  type UiFeatureContext,
  useFeatureStore,
  useService,
} from '@poietica/ui-kernel'
import { FileDiff } from 'lucide-react'
import type { ReactNode } from 'react'
import type { GithubPullRequest } from '../contract'
import { PrDetail, PrDetailActions } from './pr-detail'
import { PrInfo } from './pr-info'
import { PrSidebar } from './pr-sidebar'
import { filterCounts, visiblePulls } from './pr-store'
import { usePrStore } from './pr-store-holder'

import './pr-page.css'

/*
 * 代码审查页：左列表 / 中详情 / 右信息栏。三块各有自己的文件（pr-sidebar / pr-detail / pr-info），
 * 这里只做装配与接线 —— 页面是唯一认识 RPC、平台能力与输入框的地方，三块因此保持纯展示。
 *
 * 三者共用一个 store：左栏选中谁、中栏画谁、右栏报谁的账，不会出现「列表选了 #3、右栏说的是 #2」。
 * store 按工作区常驻（pr-store-holder）：离开页面再回来不重新加载，选中项、标签页、搜索词都还在。
 * 数据源是工作区远端仓库的 GitHub pull request，读法与写法的边界在 core 侧（直连 GitHub API，见 core/github-http.ts）。
 */

export interface CodeReviewPageProps {
  readonly ctx: UiFeatureContext
  readonly workspaces: WorkspacesUi
  readonly openExternal: (url: string) => void
}

/*
 * 「发送到 agent」只把这一条 PR 的引用插进输入框，不替人发送：审查意图是用户自己补的，
 * 自动发送会在会话里留下一句谁也没想发的话。
 */
function contextPrompt(repository: string | null, pull: GithubPullRequest): string {
  const where = repository === null ? `#${String(pull.number)}` : `${repository}#${String(pull.number)}`
  return `请审查这个 pull request：${where} ${pull.title}\n${pull.url}\n`
}

export function CodeReviewPage({ ctx, workspaces, openExternal }: CodeReviewPageProps): ReactNode {
  const workspaceId = useFeatureStore(workspaces.store, (held) => held.activeId)
  const banners = useService(BannersToken) as BannerService

  if (workspaceId === null) {
    return (
      <div className="pr-page__blank">
        <FileDiff aria-hidden className="size-8 opacity-30" />
        <p className="text-sm font-medium">还没有工作区</p>
        <p className="text-xs opacity-50">先添加一个工作区，这里会展示它远端仓库上的 pull request。</p>
      </div>
    )
  }

  return (
    <CodeReviewBody
      ctx={ctx}
      key={workspaceId}
      onFailure={(cause) => {
        /* 读不到与写失败都只提示一次：页面自己降级成空态，不把用户堵在错误页上。 */
        ctx.logger.warn('代码审查页操作失败', { error: String(cause) })
        banners.error(cause)
      }}
      openExternal={openExternal}
      workspaceId={workspaceId}
    />
  )
}

/* PR 正文与评论：GitHub 上的长文，代码块封顶 420px，不走流式。 */
function renderPullMarkdown(text: string): ReactNode {
  return <Prose codeBlockMaxHeight={420} mode="static" text={text} />
}

function CodeReviewBody({
  ctx,
  onFailure,
  openExternal,
  workspaceId,
}: {
  readonly ctx: UiFeatureContext
  readonly onFailure: (cause: unknown) => void
  readonly openExternal: (url: string) => void
  readonly workspaceId: string
}): ReactNode {
  const conversation = useService(ConversationUiToken) as ConversationUi
  /*
   * 这个工作区常驻的那一份 store：挂载时 start（没读过就读，过期就背后重读，新鲜就不动），卸载时只作废还在路上的回包，
   * 数据留着给下次回来。以前这里每次挂载都 new 一份（而且 onFailure 每次渲染都是新函数，useMemo 形同虚设）。
   */
  const store = usePrStore(ctx, workspaceId, (context) => onFailure(context.cause))
  const state = useFeatureStore(store.store, (held) => held)

  const pull = state.facts.pull
  const repository = state.reading.repository

  const sendToAgent = (): void => {
    if (pull === null) {
      return
    }
    const composer = conversation.activeComposer()
    if (composer === null) {
      onFailure(new AppError('review.no_composer', '当前页面没有可用的输入框'))
      return
    }
    composer.insertText(contextPrompt(repository?.fullName ?? null, pull))
  }

  return (
    <section className="pr-page">
      <PrSidebar
        counts={filterCounts(state.reading.pulls)}
        entries={visiblePulls(state.reading.pulls, state.filter, state.query)}
        onFilter={store.setFilter}
        onQuery={store.setQuery}
        onRefresh={store.refresh}
        onSelect={store.select}
        repository={repository}
        state={state}
      />
      <div className="pr-page__detail">
        <PrDetail
          busy={state.busy}
          comments={state.comments}
          markdown={renderPullMarkdown}
          onComment={store.comment}
          onDraft={store.setDraft}
          onSetDraftState={store.setDraftState}
          onTab={store.setTab}
          progress={state.facts.phase}
          pull={pull}
          repositoryName={repository === null ? null : (repository.fullName.split('/').pop() ?? repository.name)}
          state={state}
        />
      </div>
      {/*
       * 右栏自己的一行「四个动作」摆在最上面，所以它们正好在 Merge status 那些节的上方。
       * 这一行**只属于右栏**：放在页面顶层会让左、中两栏跟着下移，中间空出一条（真机上就是这么坏的）。
       */}
      <div className="pr-page__info">
        <div className="pr-page__actions">
          <PrDetailActions
            busy={state.busy}
            onMerge={store.merge}
            onOpenExternal={() => {
              if (pull !== null) {
                openExternal(pull.url)
              }
            }}
            onSendToAgent={sendToAgent}
            pull={pull}
          />
        </div>
        {/* 这一格自己滚，动作行钉在上面（<aside aria-label="Details"> 由 PrInfo 自己画）。 */}
        <div className="pr-page__info-scroll">
          <PrInfo
            busy={state.busy}
            comments={state.comments}
            onRequestReview={() => {
              if (pull !== null) {
                openExternal(pull.url)
              }
            }}
            pull={pull}
          />
        </div>
      </div>
    </section>
  )
}
