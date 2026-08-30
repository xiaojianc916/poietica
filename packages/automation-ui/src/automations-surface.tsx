import type { SessionConfigControl } from '@poietica/agent-contract'
import {
  type AutomationDraft,
  type AutomationStore,
  BLANK_DRAFT,
  draftOf,
  draftOfTemplate,
  summarize,
} from '@poietica/automation'
import { useMemo, useState, useSyncExternalStore } from 'react'

import { AutomationEditor } from './automation-editor'
import { AutomationList } from './automation-list'
import { TemplateGallery } from './template-gallery'

/**
 * 自动化表面。
 *
 * 版式取自行业里同类页面的信息架构：页头 + 统计牌 + 列表 + 模板画廊。没有取的
 * 是 Author 与 Team 两列 —— 那两列在云端多人产品里承载真实信息，在一个本地
 * 单用户应用里只会是两列恒定值。
 *
 * 这一格自己有两屏。不是新标签页，也不是弹窗：编辑器就地占满这一格，左上角
 * 一个返回箭头回到列表。新建与编辑是同一屏 —— 那张参照图里的 Untitled 就是
 * 一条还没起名的自动化，两者要是分成两个页面，迟早长成两份几乎一样的表单。
 */

type SurfaceView =
  | { readonly kind: 'list' }
  /** 编辑已经存在的那一条。 */
  | { readonly kind: 'editor'; readonly automationId: string }
  /**
   * 新建。draft 就是表单初值：一张空表，或者模板给的那一份。
   *
   * 和上一支分开，不是共用一个 automationId: string | null —— 「null 表示新建」
   * 是个双关，而这两支携带的东西本来就不一样：一支带身份，一支带初值。
   */
  | { readonly kind: 'draft'; readonly draft: AutomationDraft }

export interface AutomationsSurfaceProps {
  /** agent 此刻报出来的可调项，由 apps/desktop 读了交进来。 */
  readonly controls: readonly SessionConfigControl[]
  readonly store: AutomationStore
}

export function AutomationsSurface({ controls, store }: AutomationsSurfaceProps) {
  const { automations, loaded } = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  )

  const [view, setView] = useState<SurfaceView>({ kind: 'list' })

  const summary = useMemo(() => summarize(automations), [automations])

  function back(): void {
    setView({ kind: 'list' })
  }

  /* 还没有身份的一份草稿，所以 automation 传 null：能删能试运行的前提是它已经存在。 */
  if (view.kind === 'draft') {
    return (
      <AutomationEditor
        automation={null}
        controls={controls}
        draft={view.draft}
        onBack={back}
        store={store}
      />
    )
  }

  /*
   * 在编辑器里删掉之后这条就找不着了，于是这里自然落回列表 —— 派生出来的，
   * 不需要在渲染期改状态，也不会悄悄退化成一张空白的新建表单。
   */
  const editing =
    view.kind === 'editor'
      ? (automations.find((candidate) => candidate.id === view.automationId) ?? null)
      : null

  if (editing !== null) {
    return (
      <AutomationEditor
        automation={editing}
        controls={controls}
        draft={draftOf(editing)}
        /* 换一条就换一个 key：草稿状态跟着重置，不会串到上一条身上。 */
        key={editing.id}
        onBack={back}
        store={store}
      />
    )
  }

  return (
    <section className="h-full overflow-y-auto bg-ground">
      <header className="px-8 pb-6 pt-8">
        <h1 className="text-lg font-semibold tracking-tight">自动化</h1>

        <p className="mt-1 max-w-2xl text-xs leading-5 text-muted-foreground">
          让重复的活儿按计划自己跑。每一次运行都会开出一条对话，做了什么、说了什么，
          都留在那条对话里。
        </p>

        <dl className="mt-6 grid grid-cols-3 gap-3">
          <Tile label="自动化" value={summary.total} />
          <Tile label="成功 · 7 天" value={summary.succeeded} />
          <Tile label="失败 · 7 天" value={summary.failed} />
        </dl>
      </header>

      <div className="px-8">
        <div className="flex items-center justify-between border-b border-divider pb-3">
          <h2 className="text-xs font-medium text-muted-foreground">我的自动化</h2>

          <button
            className="rounded-md bg-muted px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-sidebar-accent"
            onClick={() => {
              setView({ kind: 'draft', draft: BLANK_DRAFT })
            }}
            type="button"
          >
            新建自动化
          </button>
        </div>

        <AutomationList
          automations={automations}
          loaded={loaded}
          onOpen={(automationId) => {
            setView({ kind: 'editor', automationId })
          }}
          store={store}
        />
      </div>

      {/*
        点模板不落盘：摊成草稿，摆进新建界面，人看过改过按下保存才算添加。
        直接 create 等于替人做主 —— 提示词长什么样、几点跑，他一眼都没看见。
      */}
      <TemplateGallery
        onPick={(template) => {
          setView({ kind: 'draft', draft: draftOfTemplate(template) })
        }}
      />
    </section>
  )
}

function Tile({ label, value }: { readonly label: string; readonly value: number }) {
  return (
    <div className="rounded-lg border border-divider bg-background px-4 py-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-xl font-semibold tabular-nums">{value}</dd>
    </div>
  )
}
