import type { SessionConfigControl } from '@poietica/conversation'
import { isProjectlessWorkspaceRoot, workspaceRootName } from '@poietica/conversation'
import type { WorkspaceChoice } from '@poietica/conversation/surface'
import { useMemo, useState, useSyncExternalStore } from 'react'
import {
  type Automation,
  type AutomationDraft,
  type AutomationStore,
  type AutomationTemplate,
  BLANK_DRAFT,
  draftOf,
  draftOfTemplate,
} from '../index'
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
  /*
   * 换目录时能选的那些。
   *
   * 「最近用过的工作目录」不另存一份名单：已经在跑的任务占着的目录就是它，与对话
   * 那一边拿已有对话当最近名单同一条规矩。无项目会话那种内部目录不列 —— 它不是
   * 一个可以特意选中的地方。
   */
  const workspaceChoices = useMemo<readonly WorkspaceChoice[]>(() => {
    const seen = new Map<string, WorkspaceChoice>()
    for (const row of automations) {
      const root = row.workspaceRoot
      if (root === null || root === '' || seen.has(root) || isProjectlessWorkspaceRoot(root)) {
        continue
      }
      seen.set(root, { id: root, name: workspaceRootName(root) })
    }
    return [...seen.values()]
  }, [automations])
  const context = { timeZone: defaultTimeZone, workspaceRoot: '' }
  const back = () => setView({ kind: 'list' })
  const startBlank = () => setView({ kind: 'draft', draft: { ...BLANK_DRAFT, ...context } })
  const startFromTemplate = (template: AutomationTemplate) =>
    setView({ kind: 'draft', draft: draftOfTemplate(template, context) })

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
        workspaceChoices={workspaceChoices}
      />
    )
  }
  if (view.kind === 'editor') {
    const live = automations.find((row) => row.id === view.baseline.id) ?? view.baseline
    return (
      <AutomationEditor
        automation={live}
        controls={controls}
        /*
         * 编辑也落在系统时区上：界面上已经没有时区可选，任务记着的旧时区若原样带进
         * 草稿，就是一个看不见也改不了的影子。下一次保存时它会被系统时区覆盖。
         */
        draft={{ ...draftOf(view.baseline), timeZone: defaultTimeZone }}
        key={view.baseline.id}
        onBack={back}
        onOpenThread={onOpenThread}
        pickWorkspace={pickWorkspace}
        store={store}
        workspaceChoices={workspaceChoices}
      />
    )
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
            onCreateBlank={startBlank}
            onOpen={(id) => {
              const baseline = automations.find((row) => row.id === id)
              if (baseline !== undefined) {
                setView({ kind: 'editor', baseline })
              }
            }}
            onPickTemplate={startFromTemplate}
            pending={pending}
            store={store}
          />
        ) : (
          <p className="py-10 text-center text-xs text-muted-foreground">
            {error === null ? '正在读取自动化目录…' : '未能读取目录；请修复上述问题后刷新。'}
          </p>
        )}

        {loaded ? <TemplateGallery onPick={startFromTemplate} /> : null}
      </div>
    </section>
  )
}
