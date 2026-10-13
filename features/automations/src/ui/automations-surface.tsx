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

/* legacy 的这个组件自己管内部视图状态（list / draft / editor）；新架构里表面对应路由：automations.list 与 automations.edit
 * （新建为 'new'），所以拆成两个表面组件，共用一个 store 与同一份工作区选择。 */

export interface AutomationsSurfaceProps {
  readonly store: AutomationsStore
  readonly defaultTimeZone: string
  readonly onOpenThread: (threadId: string) => void
}

export function useRunsOf(store: AutomationsStore): (automationId: string) => readonly AutomationRun[] {
  const runs = useFeatureStoreShallow(store.store, (held) => held.runs)
  return useMemo(() => (automationId: string) => runs[automationId] ?? [], [runs])
}

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

/* 草稿在数据到位之后才初始化（编辑表面先等 loaded）：useState 初始化器只读一次数据来源。清空 pendingDraft 放在 effect 而不是
 * 渲染期间：StrictMode 会双调用渲染，渲染期间的副作用会丢掉预填的草稿。 */
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
