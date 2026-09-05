import {
  type Automation,
  type AutomationDraft,
  type AutomationStore,
  BLANK_DRAFT,
  draftOf,
  draftOfTemplate,
  summarize,
} from '@poietica/automation'
import type { SessionConfigControl } from '@poietica/conversation'
import { useMemo, useState, useSyncExternalStore } from 'react'
import { AutomationEditor } from './automation-editor'
import { AutomationList } from './automation-list'
import { TemplateGallery } from './template-gallery'

type SurfaceView =
  | { readonly kind: 'list' }
  | { readonly kind: 'draft'; readonly draft: AutomationDraft }
  | { readonly kind: 'editor'; readonly baseline: Automation }

export interface AutomationsSurfaceProps {
  readonly controls: readonly SessionConfigControl[]
  readonly store: AutomationStore
  readonly defaultTimeZone: string
  readonly pickWorkspace: () => Promise<string | null>
  readonly onOpenThread: (threadId: string, title: string) => void
}

export function AutomationsSurface({
  controls,
  store,
  defaultTimeZone,
  pickWorkspace,
  onOpenThread,
}: AutomationsSurfaceProps) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const { automations, loaded, error, watchError, pending } = snapshot
  const [view, setView] = useState<SurfaceView>({ kind: 'list' })
  const summary = useMemo(() => summarize(automations), [automations])
  const context = { timeZone: defaultTimeZone, workspaceRoot: '' }
  const back = () => setView({ kind: 'list' })
  if (view.kind === 'draft') {
    return (
      <AutomationEditor
        automation={null}
        controls={controls}
        draft={view.draft}
        onBack={back}
        onOpenThread={onOpenThread}
        pickWorkspace={pickWorkspace}
        store={store}
      />
    )
  }
  if (view.kind === 'editor') {
    const live = automations.find((row) => row.id === view.baseline.id) ?? view.baseline
    return (
      <AutomationEditor
        automation={live}
        controls={controls}
        draft={draftOf(view.baseline)}
        key={view.baseline.id}
        onBack={back}
        onOpenThread={onOpenThread}
        pickWorkspace={pickWorkspace}
        store={store}
      />
    )
  }
  return (
    <section className="h-full overflow-y-auto bg-ground">
      <header className="px-8 pb-6 pt-8">
        <h1 className="text-lg font-semibold tracking-tight">自动化</h1>
        <p className="mt-1 max-w-2xl text-xs leading-5 text-muted-foreground">
          计划与执行由原生进程持有，关闭此页面不会停止任务。应用退出期间不执行，重开后核对已认领的运行。
        </p>
        <dl className="mt-6 grid grid-cols-3 gap-3">
          <Tile label="自动化" value={summary.total} />
          <Tile label="保留记录内成功 · 7 天" value={summary.succeeded} />
          <Tile label="保留记录内失败 · 7 天" value={summary.failed} />
        </dl>
        {error ? (
          <p className="mt-4 text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
        {watchError ? (
          <p className="mt-4 text-sm text-destructive" role="alert">
            {watchError}
          </p>
        ) : null}
      </header>
      <div className="px-8">
        <div className="flex items-center gap-3 border-b border-divider pb-3">
          <h2 className="mr-auto text-xs font-medium text-muted-foreground">我的自动化</h2>
          <button
            className="rounded-md px-3 py-1.5 text-xs hover:bg-sidebar-accent"
            onClick={() => {
              void store.refresh()
            }}
            type="button"
          >
            刷新
          </button>
          <button
            className="rounded-md bg-muted px-3 py-1.5 text-xs font-medium disabled:opacity-40"
            disabled={!loaded}
            onClick={() => setView({ kind: 'draft', draft: { ...BLANK_DRAFT, ...context } })}
            type="button"
          >
            新建自动化
          </button>
        </div>
        {loaded ? (
          <AutomationList
            automations={automations}
            onOpen={(id) => {
              const baseline = automations.find((row) => row.id === id)
              if (baseline !== undefined) {
                setView({ kind: 'editor', baseline })
              }
            }}
            pending={pending}
            store={store}
          />
        ) : (
          <p className="py-10 text-center text-xs text-muted-foreground">
            {error === null ? '正在读取自动化目录…' : '未能读取目录；请修复上述问题后刷新。'}
          </p>
        )}
      </div>
      {loaded ? (
        <TemplateGallery
          onPick={(template) =>
            setView({ kind: 'draft', draft: draftOfTemplate(template, context) })
          }
        />
      ) : null}
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
