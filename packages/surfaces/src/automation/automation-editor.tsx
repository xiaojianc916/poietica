import {
  type Automation,
  type AutomationDraft,
  type AutomationStore,
  sameSessionConfig,
  scheduleProblem,
} from '@poietica/automation'
import type { SessionConfigControl } from '@poietica/conversation'
import {
  ArrowLeftIcon,
  Button,
  ConfirmationDialog,
  PlayIcon,
  Tabs,
  TabsList,
  TabsPanel,
  TabsTab,
} from '@poietica/design-system'
import { type ReactNode, useMemo, useState } from 'react'
import { AutomationRunHistory } from './automation-run-history'
import { AutomationScheduleField } from './automation-schedule-field'
import { AutomationSessionConfig } from './automation-session-config'

export interface AutomationEditorProps {
  readonly automation: Automation | null
  readonly controls: readonly SessionConfigControl[]
  readonly draft: AutomationDraft
  readonly onBack: () => void
  readonly store: AutomationStore
}

const FORM_ID = 'automation-editor-form'

function resolve(
  picked: Readonly<Record<string, string>>,
  controls: readonly SessionConfigControl[],
): Record<string, string> {
  const resolved: Record<string, string> = { ...picked }

  for (const control of controls) {
    resolved[control.id] = picked[control.id] ?? control.current
  }

  return resolved
}

function Field({
  children,
  htmlFor,
  label,
}: {
  readonly children: ReactNode
  readonly htmlFor?: string
  readonly label: string
}) {
  return (
    <section>
      {htmlFor === undefined ? (
        <h2 className="text-sm font-medium text-foreground">{label}</h2>
      ) : (
        <label className="text-sm font-medium text-foreground" htmlFor={htmlFor}>
          {label}
        </label>
      )}
      <div className="mt-2">{children}</div>
    </section>
  )
}

export function AutomationEditor({
  automation,
  controls,
  draft,
  onBack,
  store,
}: AutomationEditorProps) {
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveFailed, setSaveFailed] = useState(false)
  const [title, setTitle] = useState(draft.title)
  const [prompt, setPrompt] = useState(draft.prompt)
  const [schedule, setSchedule] = useState<string | null>(draft.schedule)
  const [picked, setPicked] = useState<Record<string, string>>(() => ({ ...draft.sessionConfig }))

  const sessionConfig = useMemo(() => resolve(picked, controls), [controls, picked])
  const runs = automation?.runs ?? []
  const ready =
    title.trim().length > 0 && prompt.trim().length > 0 && scheduleProblem(schedule) === null
  const dirty =
    automation === null ||
    title !== draft.title ||
    prompt !== draft.prompt ||
    draft.schedule !== schedule ||
    !sameSessionConfig(draft.sessionConfig, sessionConfig)

  function choose(controlId: string, value: string): void {
    setPicked((current) => ({ ...current, [controlId]: value }))
  }

  async function save(): Promise<void> {
    if (!ready || !dirty || saving) {
      return
    }

    setSaving(true)
    setSaveFailed(false)
    const next = { prompt: prompt.trim(), schedule, sessionConfig, title: title.trim() }
    const saved =
      automation === null ? await store.create(next) : await store.update(automation.id, next)
    setSaving(false)

    if (saved) {
      onBack()
    } else {
      setSaveFailed(true)
    }
  }

  return (
    <Tabs className="flex h-full flex-col overflow-y-auto bg-ground" defaultValue="settings">
      <header className="sticky top-0 z-10 bg-ground/95 backdrop-blur">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-3 px-8 py-5">
          <div className="flex items-center gap-3">
            <Button
              aria-label="返回自动化列表"
              onClick={onBack}
              size="icon"
              type="button"
              variant="ghost"
            >
              <ArrowLeftIcon className="size-4" />
            </Button>
            <TabsList aria-label="自动化编辑视图">
              <TabsTab value="settings">设置</TabsTab>
              <TabsTab value="runs">
                历史
                {runs.length > 0 ? (
                  <span className="ml-1.5 tabular-nums opacity-60">{runs.length}</span>
                ) : null}
              </TabsTab>
            </TabsList>
          </div>

          <div className="flex items-center gap-1">
            {automation === null ? null : (
              <>
                <Button
                  disabled={saving}
                  onClick={() => {
                    store.runNow(automation.id)
                  }}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  <PlayIcon className="mr-1 size-3.5" />
                  试运行
                </Button>
                <Button
                  className="text-destructive"
                  disabled={saving}
                  onClick={() => {
                    setConfirmingDelete(true)
                  }}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  删除
                </Button>
              </>
            )}
            <Button
              className="rounded-lg bg-foreground text-ground hover:bg-foreground/90"
              disabled={!ready || !dirty || saving}
              form={FORM_ID}
              size="sm"
              type="submit"
            >
              {saving ? '保存中…' : automation === null ? '创建自动化' : '保存'}
            </Button>
          </div>
        </div>
      </header>

      <div className="mx-auto w-full max-w-5xl px-8 pb-16 pt-4">
        <TabsPanel value="settings">
          <form
            aria-busy={saving}
            className="flex flex-col gap-7"
            id={FORM_ID}
            onSubmit={(event) => {
              event.preventDefault()
              void save()
            }}
          >
            <Field htmlFor="automation-title" label="任务标题">
              <input
                autoComplete="off"
                className="h-11 w-full rounded-xl border border-divider bg-background px-4 text-sm text-foreground outline-none placeholder:text-placeholder focus-visible:ring-2 focus-visible:ring-ring"
                id="automation-title"
                onChange={(event) => {
                  setTitle(event.target.value)
                }}
                placeholder="未命名任务"
                value={title}
              />
            </Field>

            <Field label="调度">
              <AutomationScheduleField onChange={setSchedule} schedule={schedule} />
            </Field>

            <Field htmlFor="automation-prompt" label="指令">
              <div className="overflow-hidden rounded-xl border border-divider bg-background focus-within:ring-2 focus-within:ring-ring">
                <textarea
                  className="min-h-48 w-full resize-y bg-transparent px-4 py-3 text-sm leading-6 text-foreground outline-none placeholder:text-placeholder"
                  id="automation-prompt"
                  onChange={(event) => {
                    setPrompt(event.target.value)
                  }}
                  placeholder="到期时发给 agent 的指令"
                  value={prompt}
                />
                <div className="flex flex-wrap items-center gap-1 border-t border-divider/60 bg-sidebar-accent/20 px-2.5 py-2">
                  <AutomationSessionConfig controls={controls} onChange={choose} value={picked} />
                </div>
              </div>
            </Field>

            {saveFailed ? (
              <p className="text-sm text-destructive" role="alert">
                保存失败，草稿仍保留在当前页面，请重试。
              </p>
            ) : null}
          </form>
        </TabsPanel>

        <TabsPanel value="runs">
          <AutomationRunHistory runs={runs} />
        </TabsPanel>
      </div>

      <ConfirmationDialog
        confirmLabel="删除"
        description={`「${automation?.title ?? ''}」与它的运行记录将一并删除，不可恢复。`}
        destructive
        onCancel={() => {
          setConfirmingDelete(false)
        }}
        onConfirm={() => {
          if (automation !== null) {
            store.remove(automation.id)
          }
          setConfirmingDelete(false)
          onBack()
        }}
        open={confirmingDelete}
        title="删除这条自动化？"
      />
    </Tabs>
  )
}
