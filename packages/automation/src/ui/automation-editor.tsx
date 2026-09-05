import '@poietica/composer/frame.css'
import {
  type Automation,
  type AutomationDraft,
  type AutomationStore,
  activeRun,
  type SchedulePreview,
  sameSessionConfig,
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
import { warn } from '@poietica/problem'
import { type ReactNode, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { AutomationRunHistory } from './automation-run-history'
import { AutomationScheduleField } from './automation-schedule-field'
import { AutomationSessionConfig } from './automation-session-config'

export interface AutomationEditorProps {
  readonly automation: Automation | null
  readonly controls: readonly SessionConfigControl[]
  readonly draft: AutomationDraft
  readonly store: AutomationStore
  readonly onBack: () => void
  readonly pickWorkspace: () => Promise<string | null>
  readonly onOpenThread: (threadId: string, title: string) => void
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

interface PreviewState {
  readonly schedule: string | null
  readonly zone: string
  readonly preview: SchedulePreview | null
  readonly error: string | null
}

export function AutomationEditor({
  automation,
  controls,
  draft,
  store,
  onBack,
  pickWorkspace,
  onOpenThread,
}: AutomationEditorProps) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const [baselineDraft] = useState(draft)
  const [revision, setRevision] = useState(automation?.revision ?? null)
  const [enabled, setEnabled] = useState(automation?.enabled ?? true)
  const [title, setTitle] = useState(draft.title)
  const [prompt, setPrompt] = useState(draft.prompt)
  const [schedule, setSchedule] = useState(draft.schedule)
  const [timeZone, setTimeZone] = useState(draft.timeZone)
  const [workspaceRoot, setWorkspaceRoot] = useState(draft.workspaceRoot)
  const [picked, setPicked] = useState<Record<string, string>>(() => ({ ...draft.sessionConfig }))
  const [saving, setSaving] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [confirmingRevision, setConfirmingRevision] = useState(false)
  const [confirmingBack, setConfirmingBack] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  const [previewState, setPreviewState] = useState<PreviewState | null>(null)
  const sessionConfig = useMemo(() => resolve(picked, controls), [picked, controls])
  const dirty =
    automation === null ||
    title !== baselineDraft.title ||
    prompt !== baselineDraft.prompt ||
    schedule !== baselineDraft.schedule ||
    timeZone !== baselineDraft.timeZone ||
    workspaceRoot !== baselineDraft.workspaceRoot ||
    !sameSessionConfig(sessionConfig, baselineDraft.sessionConfig)
  const conflict = automation !== null && automation.revision !== revision
  const previewMatches = previewState?.schedule === schedule && previewState.zone === timeZone
  const preview = previewMatches ? previewState.preview : null
  const previewError = previewMatches ? previewState.error : null
  const ready =
    title.trim() !== '' &&
    prompt.trim() !== '' &&
    workspaceRoot.trim() !== '' &&
    preview !== null &&
    preview.problem === null
  const active = automation === null ? null : activeRun(automation)

  useEffect(() => {
    let disposed = false
    const timer = setTimeout(() => {
      void store.preview(schedule, timeZone).then(
        (preview) => {
          if (!disposed) {
            setPreviewState({ schedule, zone: timeZone, preview, error: null })
          }
        },
        (cause: unknown) => {
          if (!disposed) {
            warn('自动化计划校验失败', { scope: 'automation', cause })
            setPreviewState({
              schedule,
              zone: timeZone,
              preview: null,
              error: cause instanceof Error ? cause.message : String(cause),
            })
          }
        },
      )
    }, 250)
    return () => {
      disposed = true
      clearTimeout(timer)
    }
  }, [store, schedule, timeZone])

  async function chooseWorkspace(): Promise<void> {
    try {
      const selected = await pickWorkspace()
      if (selected !== null) {
        setWorkspaceRoot(selected)
        setLocalError(null)
      }
    } catch (cause: unknown) {
      warn('自动化目录选择失败', { scope: 'automation', cause })
      setLocalError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  async function save(): Promise<void> {
    if (!ready || !dirty || saving || conflict) {
      return
    }
    setSaving(true)
    setLocalError(null)
    const next: AutomationDraft = {
      title: title.trim(),
      prompt: prompt.trim(),
      schedule,
      timeZone,
      workspaceRoot,
      sessionConfig,
    }
    try {
      const saved =
        automation === null || revision === null
          ? await store.create(next)
          : await store.update(automation.id, revision, next, enabled)
      if (saved) {
        onBack()
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <Tabs className="flex h-full flex-col overflow-y-auto bg-ground" defaultValue="settings">
      <header className="sticky top-0 z-10 bg-ground/95 backdrop-blur">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-3 px-8 py-5">
          <div className="flex items-center gap-3">
            <Button
              aria-label="返回自动化列表"
              disabled={saving}
              onClick={() => {
                if (dirty) {
                  setConfirmingBack(true)
                } else {
                  onBack()
                }
              }}
              size="icon"
              type="button"
              variant="ghost"
            >
              <ArrowLeftIcon className="size-4" />
            </Button>
            <TabsList aria-label="自动化编辑视图">
              <TabsTab value="settings">设置</TabsTab>
              <TabsTab value="runs">历史 · {automation?.runs.length ?? 0}</TabsTab>
            </TabsList>
          </div>
          <div className="flex items-center gap-1">
            {automation === null ? null : (
              <>
                <Button
                  disabled={saving || dirty || active !== null || conflict}
                  onClick={() => {
                    void store.runNow(automation.id)
                  }}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  <PlayIcon className="mr-1 size-3.5" />
                  运行已保存版本
                </Button>
                <Button
                  className="text-destructive"
                  disabled={saving || active !== null}
                  onClick={() => setConfirmingDelete(true)}
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
              disabled={!ready || !dirty || saving || conflict}
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
        {(localError ?? snapshot.error) ? (
          <p className="mb-4 text-sm text-destructive" role="alert">
            {localError ?? snapshot.error}
          </p>
        ) : null}
        {automation?.issue ? (
          <p className="mb-4 text-sm text-destructive" role="alert">
            {automation.issue}
          </p>
        ) : null}
        {conflict ? (
          <div className="mb-4 flex items-center gap-3 text-sm" role="alert">
            <span>任务已被其他操作修改。当前草稿仍保留，尚未覆盖最新版本。</span>
            <Button
              onClick={() => setConfirmingRevision(true)}
              size="sm"
              type="button"
              variant="outline"
            >
              保留草稿并重新确认
            </Button>
          </div>
        ) : null}
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
                className="h-11 w-full rounded-xl border border-divider bg-background px-4 text-sm"
                id="automation-title"
                onChange={(event) => setTitle(event.currentTarget.value)}
                placeholder="未命名任务"
                value={title}
              />
            </Field>
            <Field htmlFor="automation-workspace" label="工作目录">
              <div className="flex gap-2">
                <input
                  className="h-11 min-w-0 flex-1 rounded-xl border border-divider bg-background px-4 text-sm"
                  id="automation-workspace"
                  placeholder="请选择任务实际操作的目录"
                  readOnly
                  value={workspaceRoot}
                />
                <Button
                  onClick={() => {
                    void chooseWorkspace()
                  }}
                  type="button"
                  variant="outline"
                >
                  选择目录
                </Button>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                执行时使用这里保存的目录，不跟随当前打开的工作区。
              </p>
            </Field>
            <Field label="调度">
              <AutomationScheduleField
                error={previewError}
                onChange={setSchedule}
                onTimeZoneChange={setTimeZone}
                preview={preview}
                schedule={schedule}
                timeZone={timeZone}
              />
              {schedule === null ? null : (
                <label className="mt-3 flex items-center gap-2 text-sm">
                  <input
                    checked={enabled}
                    onChange={(event) => setEnabled(event.currentTarget.checked)}
                    type="checkbox"
                  />
                  启用周期计划
                </label>
              )}
            </Field>
            <Field htmlFor="automation-prompt" label="指令">
              <div className="assistant-prompt-input" data-assistant-skin data-slot="prompt-input">
                <div data-slot="prompt-input-body">
                  <div className="assistant-prompt-editor">
                    <textarea
                      aria-label="指令"
                      className="assistant-prompt-editor__input"
                      data-slot="prompt-input-editor"
                      id="automation-prompt"
                      onChange={(event) => setPrompt(event.currentTarget.value)}
                      placeholder="到期时发给 agent 的指令"
                      value={prompt}
                    />
                  </div>
                </div>
                <div data-slot="prompt-input-toolbar">
                  <AutomationSessionConfig
                    controls={controls}
                    onChange={(id, value) => setPicked((current) => ({ ...current, [id]: value }))}
                    value={picked}
                  />
                </div>
              </div>
            </Field>
          </form>
        </TabsPanel>
        <TabsPanel value="runs">
          <AutomationRunHistory
            onCancel={(runId) => {
              void store.cancel(runId)
            }}
            onOpenThread={onOpenThread}
            runs={automation?.runs ?? []}
            title={automation?.title ?? title}
          />
        </TabsPanel>
      </div>
      <ConfirmationDialog
        confirmLabel="删除"
        description="删除任务定义与保留的运行索引；已有对话内容仍然保留。活动运行必须先结束。"
        destructive
        onCancel={() => setConfirmingDelete(false)}
        onConfirm={() => {
          if (automation !== null) {
            void store.remove(automation.id).then((removed) => {
              if (removed) {
                onBack()
              }
            })
          }
          setConfirmingDelete(false)
        }}
        open={confirmingDelete}
        title="删除这条自动化？"
      />
      <ConfirmationDialog
        confirmLabel="继续编辑"
        description="草稿字段会在下一次保存时覆盖最新版本；此刻只更新版本基线，不自动写入。"
        onCancel={() => setConfirmingRevision(false)}
        onConfirm={() => {
          if (automation !== null) {
            setRevision(automation.revision)
          }
          setConfirmingRevision(false)
        }}
        open={confirmingRevision}
        title="用当前草稿编辑最新版本？"
      />
      <ConfirmationDialog
        confirmLabel="放弃草稿"
        description="尚未保存的字段不会写入任务。"
        destructive
        onCancel={() => setConfirmingBack(false)}
        onConfirm={onBack}
        open={confirmingBack}
        title="放弃未保存的草稿？"
      />
    </Tabs>
  )
}
