import { invariant } from '@poietica/foundation'
import { useFeatureStore } from '@poietica/ui-kernel'
import { type ReactNode, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import type { GithubPullRequest, GithubRepository } from '../src/contract'
import { PrDetail, PrDetailActions } from '../src/ui/pr-detail'
import { PrInfo } from '../src/ui/pr-info'
import { PrSidebar } from '../src/ui/pr-sidebar'
import { createPrStore, type PrStore } from '../src/ui/pr-store'

/* 样式不在这里 import：宿主把 Tailwind 编好的整份样式表注入 <style>，本文件只管渲染组件。 */

/*
 * 代码审查页的真机冒烟：真实 Electron + 真实组件 + 真 GitHub 数据（脚本侧读到后经 window.__prFixture 注入）。
 * 它不做判断，只把读到的几何交回宿主 stdout；阈值与判定在 tooling/checks/review-page/run.ts。
 */

export interface PrFixture {
  readonly pull: GithubPullRequest
  readonly repository: GithubRepository
  readonly login: string
}

declare global {
  interface Window {
    __prFixture?: PrFixture
    __prReport?: unknown
    __prDone?: () => void
  }
}

/* markdown 由页面注入；冒烟里给一个只认 "## 标题 + 段落" 的替身 —— 验的是版面，不是 markdown 引擎。 */
function stubMarkdown(text: string): ReactNode {
  return (
    <>
      {text.split(/\n(?=## )/u).map((block, index) => {
        const [head = '', ...rest] = block.split('\n')
        return (
          <section key={index}>
            {head.trim() === '' ? null : <h2>{head.replace(/^#+\s*/u, '')}</h2>}
            {rest
              .filter((line) => line.trim() !== '')
              .map((line, i) => (
                <p key={i}>{line}</p>
              ))}
          </section>
        )
      })}
    </>
  )
}

function Frame({ store, fixture }: { readonly store: PrStore; readonly fixture: PrFixture }): ReactNode {
  const state = useFeatureStore(store.store, (held) => held)
  return (
    <div style={{ height: '100vh', width: '100vw' }}>
      <section className="pr-page">
        <PrSidebar
          counts={{ all: 1, prs: 1, issues: 0 }}
          entries={[fixture.pull]}
          onFilter={() => undefined}
          onQuery={() => undefined}
          onRefresh={() => undefined}
          onSelect={() => undefined}
          repository={fixture.repository}
          state={state}
        />
        <div className="pr-page__detail">
          <PrDetail
            busy={false}
            comments={{ phase: 'ready', items: [] }}
            markdown={stubMarkdown}
            onComment={() => undefined}
            onDraft={() => undefined}
            onSetDraftState={() => undefined}
            onTab={() => undefined}
            progress={state.facts.phase}
            pull={state.facts.pull}
            repositoryName={fixture.repository.name}
            state={state}
          />
        </div>
        <div className="pr-page__info">
          <div className="pr-page__actions">
            <PrDetailActions
              busy={false}
              onMerge={() => undefined}
              onOpenExternal={() => undefined}
              onSendToAgent={() => undefined}
              pull={state.facts.pull}
            />
          </div>
          <div className="pr-page__info-scroll">
            <PrInfo
              busy={false}
              comments={{ phase: 'ready', items: [] }}
              onRequestReview={() => undefined}
              pull={state.facts.pull}
            />
          </div>
        </div>
      </section>
    </div>
  )
}

/* 夹具由宿主在加载脚本前注入；没有它就是这一条冒烟自己被装坏了（程序不变量，不是业务错误）。 */
invariant(window.__prFixture !== undefined, 'window.__prFixture 没有注入')
const fixture = window.__prFixture

const store = createPrStore({
  gateway: {
    availability: async () => ({ available: true, reason: null, login: fixture.login }),
    pullRequests: async () => ({ repository: fixture.repository, pulls: [fixture.pull] }),
    pullRequest: async () => fixture.pull,
    comments: async () => [],
    comment: async () => ({
      id: '1',
      kind: 'comment',
      author: fixture.login,
      avatarUrl: null,
      body: '',
      createdAt: new Date().toISOString(),
      reviewState: null,
    }),
    merge: async () => undefined,
  },
  report: () => undefined,
})
store.start()
/* 选中那一条：三栏都要有内容才量得到东西。 */
store.select(fixture.pull.number)

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <Frame fixture={fixture} store={store} />
  </StrictMode>,
)
