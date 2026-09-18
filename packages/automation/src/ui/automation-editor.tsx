import '@poietica/conversation/composer/frame.css'

import type { SessionConfigControl } from '@poietica/conversation'
import { workspaceRootName } from '@poietica/conversation'
import {
  AssistantComposer,
  ComposerDraftKeyContext,
  SwarmToggle,
  type WorkspaceChoice,
  WorkspacePicker,
} from '@poietica/conversation/surface'
import {
  ArrowLeftIcon,
  Button,
  ConfirmationDialog,
  PlayIcon,
  SegmentedControl,
  type SegmentedOption,
} from '@poietica/design-system'
import { warn } from '@poietica/problem'
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react'
import {
  type Automation,
  type AutomationDraft,
  type AutomationStore,
  activeRun,
  type SchedulePreview,
  sameSessionConfig,
} from '../index'
import { AutomationRunHistory } from './automation-run-history'
import { AutomationScheduleField } from './automation-schedule-field'

export interface AutomationEditorProps {
  readonly automation: Automation | null
  readonly controls: readonly SessionConfigControl[]
  readonly draft: AutomationDraft
  readonly store: AutomationStore
  readonly onBack: () => void
  readonly pickWorkspace: () => Promise<string | null>
  readonly onOpenThread: (threadId: string, title: string) => void
  /** 别处已经用过的工作目录。任务自己的目录也从这里换。 */
  readonly workspaceChoices: readonly WorkspaceChoice[]
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

/*
 * 人选过的档位，以及写它的那一格。
 *
 * 写入口的引用要稳：它进的是工具条那几个 memo 的依赖表，换一次就整排重建。
 * 记的只是「人选过的」，没选过的仍由 agent 报的那张表说了算（见 resolve）。
 */
function usePickedSessionConfig(
  initial: Readonly<Record<string, string>>,
): readonly [Record<string, string>, (controlId: string, value: string) => void] {
  const [picked, setPicked] = useState<Record<string, string>>(() => ({ ...initial }))
  const select = useCallback((controlId: string, value: string) => {
    setPicked((current) => ({ ...current, [controlId]: value }))
  }, [])

  return [picked, select]
}

/*
 * 这条任务记着的目录，交给上下文栏那枚 chip。还没选过就是 null —— chip 那时候
 * 显示的是「选择项目」。
 */
function workspaceChoiceOf(root: string): WorkspaceChoice | null {
  return root === '' ? null : { id: root, name: workspaceRootName(root) ?? root }
}

/* 输入框草稿的键。入口那一条不跟对话入口共用一个，否则两边的草稿会串到对方框里。 */
function draftKeyOf(automation: Automation | null): string {
  return automation === null ? 'automation:new' : `automation:${automation.id}`
}

/*
 * 交回 agent 那张表，但把这一条任务记着的档位摆到台前。
 *
 * 任务可以在没连上 agent 的时候打开，那时 agent 报的档位表里没有它存着的那一档；
 * 少一档就等于屏幕上那颗胶囊显示的不是它真正要用的档位。所以缺的补进候选集并注明
 * 来历 —— 不是替 agent 编一档，是让记录里的值有地方站。
 *
 * appliesOnSubmit 不在往下传的那几格里。它说的是「这一档要跟着下一句一起交出去」，
 * 而自动化每一档都跟着这次运行新建的会话走，没有「下一句」这回事；传下去，面板里
 * 那一行就成了一个只落在草稿里、永远交不出去的动作。
 */
function project(
  controls: readonly SessionConfigControl[],
  value: Readonly<Record<string, string>>,
): readonly SessionConfigControl[] {
  return controls.map((control) => {
    const current = value[control.id] ?? control.current
    const known = control.choices.some((choice) => choice.value === current)

    return {
      choices: known
        ? control.choices
        : [...control.choices, { value: current, label: `${current}（agent 未提供）` }],
      current,
      detail: control.detail,
      id: control.id,
      label: control.label,
      purpose: control.purpose,
    }
  })
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

function EditorDialogs({
  automation,
  confirmingBack,
  confirmingDelete,
  confirmingRevision,
  onBack,
  onKeepDraft,
  setConfirmingBack,
  setConfirmingDelete,
  setConfirmingRevision,
  store,
}: {
  readonly automation: Automation | null
  readonly confirmingBack: boolean
  readonly confirmingDelete: boolean
  readonly confirmingRevision: boolean
  readonly onBack: () => void
  readonly onKeepDraft: () => void
  readonly setConfirmingBack: (open: boolean) => void
  readonly setConfirmingDelete: (open: boolean) => void
  readonly setConfirmingRevision: (open: boolean) => void
  readonly store: AutomationStore
}) {
  return (
    <>
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
          onKeepDraft()
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
    </>
  )
}

type EditorView = 'settings' | 'runs'

const EDITOR_VIEWS = [
  { value: 'settings', label: '设置' },
  { value: 'runs', label: '历史' },
] as const satisfies readonly SegmentedOption<EditorView>[]

function EditorHeader({
  automation,
  conflict,
  dirty,
  onBack,
  onDelete,
  onViewChange,
  ready,
  saving,
  store,
  view,
}: {
  readonly automation: Automation | null
  readonly conflict: boolean
  readonly dirty: boolean
  readonly onBack: () => void
  readonly onDelete: () => void
  readonly onViewChange: (view: EditorView) => void
  readonly ready: boolean
  readonly saving: boolean
  readonly store: AutomationStore
  readonly view: EditorView
}) {
  const active = automation === null ? null : activeRun(automation)
  return (
    <header className="sticky top-0 z-10 bg-ground/95 backdrop-blur">
      <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-3 px-8 py-5">
        <div className="flex items-center gap-3">
          <Button
            aria-label="返回自动化列表"
            disabled={saving}
            onClick={onBack}
            size="icon"
            type="button"
            variant="ghost"
          >
            <ArrowLeftIcon className="size-4" />
          </Button>
          <SegmentedControl
            label="自动化编辑视图"
            name="automation-editor-view"
            onValueChange={onViewChange}
            options={EDITOR_VIEWS}
            value={view}
          />
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
                onClick={onDelete}
                size="sm"
                type="button"
                variant="ghost"
              >
                删除
              </Button>
            </>
          )}
          {/* 与设置页几个提交键同一档（soft + xs）：中性灰、无框、26px。 */}
          <Button
            disabled={!ready || !dirty || saving || conflict}
            form={FORM_ID}
            size="xs"
            type="submit"
            variant="soft"
          >
            {saving ? '保存中…' : automation === null ? '创建自动化' : '保存'}
          </Button>
        </div>
      </div>
    </header>
  )
}

export function AutomationEditor({
  automation,
  controls,
  draft,
  store,
  onBack,
  pickWorkspace,
  onOpenThread,
  workspaceChoices,
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
  const [picked, selectControl] = usePickedSessionConfig(draft.sessionConfig)
  const [saving, setSaving] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [confirmingRevision, setConfirmingRevision] = useState(false)
  const [confirmingBack, setConfirmingBack] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  const [previewState, setPreviewState] = useState<PreviewState | null>(null)
  const [view, setView] = useState<EditorView>('settings')
  const sessionConfig = useMemo(() => resolve(picked, controls), [picked, controls])
  const sessionControls = useMemo(() => project(controls, picked), [controls, picked])
  const currentWorkspace = workspaceChoiceOf(workspaceRoot)
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

  function requestBack(): void {
    if (dirty) {
      setConfirmingBack(true)
    } else {
      onBack()
    }
  }

  function keepDraft(): void {
    if (automation !== null) {
      setRevision(automation.revision)
    }
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto bg-ground">
      <EditorHeader
        automation={automation}
        conflict={conflict}
        dirty={dirty}
        onBack={requestBack}
        onDelete={() => {
          setConfirmingDelete(true)
        }}
        onViewChange={setView}
        ready={ready}
        saving={saving}
        store={store}
        view={view}
      />
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
        {view === 'settings' ? (
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
              {/* 底与「添加计划」「IANA 时区」同读 --ui-popover；焦点不换框色、不画环。 */}
              <input
                autoComplete="off"
                className="h-11 w-full rounded-xl border border-divider bg-popover px-4 text-sm outline-none"
                id="automation-title"
                onChange={(event) => setTitle(event.currentTarget.value)}
                placeholder="未命名任务"
                value={title}
              />
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
            <Field label="指令">
              {/*
                这里放的就是对话那张输入框本身：同一张卡、同一排工具条、加号翻开的
                同一张面板。它没有收信人（不给 onSubmit），所以没有发送键、Enter 只
                换行 —— 它的提交键是页头那颗。正文经 onChange 回到 prompt 那一格，
                与别的字段没有分别。

                「在哪跑」跟着这张卡走，不由页面上另开一栏问：工作目录是执行上下文，
                而执行上下文一直长在输入框下沿（见 composer-frame.css 的
                .composer-context）。所以这一栏里没有它，它在卡下面那条灰栏上。
              */}
              <div className="flex flex-col" data-assistant-skin>
                {/* 草稿的册子由组合根给（ComposerDraftsContext），这一格只认领一个键。 */}
                <ComposerDraftKeyContext value={draftKeyOf(automation)}>
                  <AssistantComposer
                    attachments={false}
                    controls={sessionControls}
                    initialText={baselineDraft.prompt}
                    onChange={setPrompt}
                    onSelectControl={selectControl}
                    placeholder="到期时发给 agent 的指令"
                  />
                </ComposerDraftKeyContext>

                <div className="composer-context">
                  <WorkspacePicker
                    choices={workspaceChoices}
                    current={currentWorkspace}
                    onBrowse={() => {
                      void chooseWorkspace()
                    }}
                    onChoose={setWorkspaceRoot}
                    placement="composer"
                  />

                  {/* 最右端：左边那枚说「在哪跑」，它说「这一句怎么跑」。 */}
                  <SwarmToggle controls={sessionControls} onSelect={selectControl} />
                </div>
              </div>
            </Field>
          </form>
        ) : null}
        {view === 'runs' ? (
          <AutomationRunHistory
            onCancel={(runId) => {
              void store.cancel(runId)
            }}
            onOpenThread={onOpenThread}
            runs={automation?.runs ?? []}
            title={automation?.title ?? title}
          />
        ) : null}
      </div>
      <EditorDialogs
        automation={automation}
        confirmingBack={confirmingBack}
        confirmingDelete={confirmingDelete}
        confirmingRevision={confirmingRevision}
        onBack={onBack}
        onKeepDraft={keepDraft}
        setConfirmingBack={setConfirmingBack}
        setConfirmingDelete={setConfirmingDelete}
        setConfirmingRevision={setConfirmingRevision}
        store={store}
      />
    </div>
  )
}
