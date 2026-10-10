import { type WorkspaceChoice, type WorkspacesUi, WorkspacesUiToken } from '@poietica/feature-workspaces/ui-api'
import {
  type NavigationService,
  NavigationToken,
  useFeatureStore,
  useFeatureStoreShallow,
  useService,
} from '@poietica/ui-kernel'
import { useEffect, useMemo, useState } from 'react'
import type { Automation, AutomationDraft, AutomationRun } from '../contract'
import { BLANK_DRAFT, draftOf } from './automation'
import { AutomationEditor } from './automation-editor'
import { AutomationList } from './automation-list'
import type { AutomationsStore } from './automations-store'
import { TemplateGallery } from './template-gallery'
import { type AutomationTemplate, draftOfTemplate } from './templates'

/*
 * 自动化表面（07 页 §9E 的 `surfaces`）。
 *
 * legacy 的这个组件自己管一个内部视图状态（list / draft / editor），因为整个自动化
 * 功能是一张单页。新架构里表面对应路由：`automations.list` 与 `automations.edit`
 * （参数 automationId，新建为 'new'），所以这里拆成两个表面组件；两者共用一个
 * AutomationsStore 与同一份工作区选择。
 *
 * 工作区 choices 由 WorkspacesUiToken 派生（新架构里工作区是 workspaces 的实体，
 * 有 id 与 name 两格），不再像 legacy 那样从已有任务的目录里反推。
 */

export interface AutomationsSurfaceProps {
  readonly store: AutomationsStore
  /** 新建/编辑时用的系统时区；由组合根按 Intl 算出（07 页 §9E）。 */
  readonly defaultTimeZone: string
  readonly onOpenThread: (threadId: string) => void
}

/** 任务的运行记录（store 里按 id 缓存；实体只带 lastRun）。 */
export function useRunsOf(store: AutomationsStore): (automationId: string) => readonly AutomationRun[] {
  const runs = useFeatureStoreShallow(store.store, (held) => held.runs)
  return useMemo(() => (automationId: string) => runs[automationId] ?? [], [runs])
}

/** 工作区 choices：WorkspacesUi 的 store 是布局列，选器要的是 {id,name} 两格。 */
function useWorkspaceChoices(): readonly WorkspaceChoice[] {
  const workspaces = useService(WorkspacesUiToken) as WorkspacesUi
  const items = useFeatureStoreShallow(workspaces.store, (held) => held.items)
  return useMemo(
    () =>
      items.filter((workspace) => workspace.exists).map((workspace) => ({ id: workspace.id, name: workspace.name })),
    [items],
  )
}

function usePickWorkspace(): () => Promise<string | null> {
  const workspaces = useService(WorkspacesUiToken) as WorkspacesUi
  return useMemo(
    () => async () => {
      const workspace = await workspaces.pickAndAdd()
      return workspace?.id ?? null
    },
    [workspaces],
  )
}

/* ── 列表表面 ─────────────────────────────────────────────────────────────── */

export function AutomationsListSurface({ store }: AutomationsSurfaceProps) {
  const navigation = useService(NavigationToken) as NavigationService
  const automations = useFeatureStoreShallow(store.store, (held) => held.automations)
  const runsOf = useRunsOf(store)
  const loaded = useFeatureStore(store.store, (held) => held.loaded)
  const error = useFeatureStore(store.store, (held) => held.error)
  const watchError = useFeatureStore(store.store, (held) => held.watchError)
  const pending = useFeatureStoreShallow(store.store, (held) => held.pending)
  const workspaces = useService(WorkspacesUiToken) as WorkspacesUi
  const activeWorkspace = useFeatureStore(workspaces.store, (held) => held.activeId)
  const defaultTimeZone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, [])

  const start = (draft: AutomationDraft): void => {
    store.pendingDraft = draft
    navigation.navigate({ surface: 'automations.edit', params: { automationId: 'new' } })
  }

  return (
    <section className="h-full overflow-y-auto bg-ground">
      <div className="mx-auto w-full max-w-3xl px-8 pb-16 pt-10">
        <header>
          <h1 className="text-3xl font-semibold tracking-tight">自动化</h1>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">
            按计划运行任务，或在需要时随时执行。关闭此页面不会停止任务，应用退出期间不执行。
          </p>
        </header>

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

        {loaded ? (
          <AutomationList
            automations={automations}
            onCreateBlank={() => {
              start({
                ...BLANK_DRAFT,
                schedule: { cron: null, at: null, timeZone: defaultTimeZone },
                workspaceId: activeWorkspace ?? '',
              })
            }}
            onOpen={(id) => {
              navigation.navigate({ surface: 'automations.edit', params: { automationId: id } })
            }}
            pending={pending}
            runsOf={runsOf}
            store={store}
          />
        ) : (
          <p className="py-10 text-center text-xs text-muted-foreground">
            {error === null ? '正在读取自动化目录…' : '未能读取目录；请修复上述问题后刷新。'}
          </p>
        )}

        {loaded ? (
          <TemplateGallery
            onPick={(template: AutomationTemplate) => {
              start(
                draftOfTemplate(template, {
                  schedule: { cron: null, at: null, timeZone: defaultTimeZone },
                  workspaceId: activeWorkspace ?? '',
                }),
              )
            }}
          />
        ) : null}
      </div>
    </section>
  )
}

/* ── 编辑表面 ─────────────────────────────────────────────────────────────── */

export function AutomationsEditSurface({
  automationId,
  store,
  defaultTimeZone,
  onOpenThread,
}: AutomationsSurfaceProps & { readonly automationId: string }) {
  const navigation = useService(NavigationToken) as NavigationService
  const automations = useFeatureStoreShallow(store.store, (held) => held.automations)
  const runsOf = useRunsOf(store)
  const workspaceChoices = useWorkspaceChoices()
  const pickWorkspace = usePickWorkspace()
  const loaded = useFeatureStore(store.store, (held) => held.loaded)
  const existing: Automation | null =
    automationId === 'new' ? null : (automations.find((row) => row.id === automationId) ?? null)

  if (automationId !== 'new' && !loaded) {
    return (
      <section className="h-full overflow-y-auto bg-ground">
        <p className="py-10 text-center text-xs text-muted-foreground">正在读取自动化目录…</p>
      </section>
    )
  }
  if (automationId !== 'new' && existing === null) {
    return (
      <section className="h-full overflow-y-auto bg-ground">
        <p className="py-10 text-center text-xs text-muted-foreground">这条任务不存在或已被删除。</p>
      </section>
    )
  }
  return (
    <AutomationEditorHost
      automation={existing}
      defaultTimeZone={defaultTimeZone}
      key={automationId}
      onBack={() => {
        store.pendingDraft = null
        navigation.navigate({ surface: 'automations.list', params: {} })
      }}
      onOpenThread={onOpenThread}
      pickWorkspace={pickWorkspace}
      runsOf={runsOf}
      store={store}
      workspaceChoices={workspaceChoices}
    />
  )
}

/*
 * 草稿在**数据到位之后**才初始化（编辑表面先等 loaded）：宿主组件按 automationId 挂载，
 * useState 初始化器只读一次数据来源，之后目录里那条任务如何刷新都不再改草稿 —— legacy
 * 的 baselineDraft 同此。pendingDraft 的清空放在 effect（提交之后）而不是渲染期间：
 * StrictMode 会双调用渲染，渲染期间的副作用会丢掉线程动作预填的草稿。
 */
function AutomationEditorHost({
  automation,
  defaultTimeZone,
  onBack,
  onOpenThread,
  pickWorkspace,
  runsOf,
  store,
  workspaceChoices,
}: {
  readonly automation: Automation | null
  readonly defaultTimeZone: string
  readonly onBack: () => void
  readonly onOpenThread: (threadId: string) => void
  readonly pickWorkspace: () => Promise<string | null>
  readonly runsOf: (automationId: string) => readonly AutomationRun[]
  readonly store: AutomationsStore
  readonly workspaceChoices: readonly WorkspaceChoice[]
}) {
  const [draft] = useState<AutomationDraft>(() => {
    if (store.pendingDraft !== null) {
      return store.pendingDraft
    }
    if (automation === null) {
      return { ...BLANK_DRAFT, schedule: { cron: null, at: null, timeZone: defaultTimeZone } }
    }
    /* 任务记着的时区原样保留（agent 可能按别的时区建）：只有缺省时才落本机时区（审查 R-16） */
    const timeZone = automation.schedule.timeZone === '' ? defaultTimeZone : automation.schedule.timeZone
    return { ...draftOf(automation), schedule: { ...automation.schedule, timeZone } }
  })

  useEffect(() => {
    store.pendingDraft = null
  }, [store])

  return (
    <AutomationEditor
      automation={automation}
      draft={draft}
      onBack={onBack}
      onOpenThread={onOpenThread}
      pickWorkspace={pickWorkspace}
      runs={automation === null ? [] : runsOf(automation.id)}
      store={store}
      workspaceChoices={workspaceChoices}
    />
  )
}
