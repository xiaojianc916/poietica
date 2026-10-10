import './automation-composer.css'
import './automation-schedule-field.css'

import {
  Button,
  ConfirmationDialog,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  SegmentedControl,
  type SegmentedOption,
  Switch,
} from '@poietica/design-system'
import type { Controls, ModelRef } from '@poietica/engine'
import { type WorkspaceChoice, WorkspacePicker } from '@poietica/feature-workspaces/ui-api'
import { useFeatureStore } from '@poietica/ui-kernel'
import { ChevronRight, CirclePause, CirclePlay, Ellipsis, Trash } from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import type { Automation, AutomationDraft, AutomationRun, NotifyPolicy, ScheduleProblem, ThreadMode } from '../contract'
import { activeRun, sameDraft } from './automation'
import { AutomationComposer, type ModelChoices } from './automation-composer'
import { AutomationRunHistory } from './automation-run-history'
import { AutomationScheduleField, type ScheduleValue } from './automation-schedule-field'
import type { AutomationsStore } from './automations-store'

/*
 * 编辑器。逐字迁移自 legacy `packages/automation/src/ui/automation-editor.tsx`
 * （超过 400 行属于 legacy 逐字迁移的先例，P5 同此），只换数据来源：
 *
 *   - 新契约没有 revision / 乐观并发，也就没有「版本冲突」那一条警报与「保留草稿并重新
 *     确认」那一次确认；
 *   - 会话配置由 legacy 的不透明 sessionConfig 字典换成 posture / model / thinking 三格，
 *     工具条上是姿态、思考强度、模型三格（AutomationComposer；后两格的可选项读
 *     conversation 的 controls.draft，审查 R-16）；
 *   - 审查 R-16 加了「一次」计划（Schedule.at）与「运行方式」一栏（对话 / 通知 / 错过补跑）；
 *   - 工作区选择器换成 workspaces 的同一枚组件（ui-api 的公开资产），choices 由 surface
 *     从 WorkspacesUiToken 派生；
 *   - 预览按 07 页 §9E 的要求在输入停止 300ms 后请求（legacy 是 250ms），读 times[0]；
 *   - 运行历史不进 Automation 实体（实体只带 lastRun），由 surface 从 store 的 runs
 *     缓存传进来。
 */

export interface AutomationEditorProps {
  readonly automation: Automation | null
  readonly draft: AutomationDraft
  readonly runs: readonly AutomationRun[]
  readonly store: AutomationsStore
  readonly workspaceChoices: readonly WorkspaceChoice[]
  readonly onBack: () => void
  readonly pickWorkspace: () => Promise<string | null>
  readonly onOpenThread: (threadId: string) => void
}

const FORM_ID = 'automation-editor-form'

/* 「调度」标题右边那句旁注：下一次什么时候跑。以本机时间计。 */
function statusText(
  preview: { readonly times: readonly number[]; readonly problem: ScheduleProblem | null } | null,
): string {
  if (preview === null) {
    return '正在由原生调度器校验…'
  }
  const next = preview.times[0]
  if (next === undefined) {
    return '没有下一次运行'
  }
  return ['下一次：', new Date(next).toLocaleString('zh-CN')].join('')
}

function workspaceChoiceOf(workspaceId: string, choices: readonly WorkspaceChoice[]): WorkspaceChoice | null {
  if (workspaceId === '') {
    return null
  }
  return choices.find((choice) => choice.id === workspaceId) ?? { id: workspaceId, name: workspaceId }
}

/*
 * 表单上方的两条警报：本地/全局错误与任务自带的问题。有哪条报哪条。
 *
 * legacy 还有第三条 —— 版本冲突。新契约（07 页 §9B）没有 revision，写入不做乐观并发，
 * 那一条随之取消。
 */
function EditorAlerts({ issue, message }: { readonly issue: string | null; readonly message: string | null }) {
  return (
    <>
      {message ? (
        <p className="mb-4 text-sm text-destructive" role="alert">
          {message}
        </p>
      ) : null}
      {issue ? (
        <p className="mb-4 text-sm text-destructive" role="alert">
          {issue}
        </p>
      ) : null}
    </>
  )
}

type EditorView = 'settings' | 'runs'

const EDITOR_VIEWS = [
  { value: 'settings', label: '设置' },
  { value: 'runs', label: '历史' },
] as const satisfies readonly SegmentedOption<EditorView>[]

/*
 * 面包屑是这一页唯一确定的返回入口，坐在页面最左上角：贴面板内缘 16px —— 与面板
 * 卡片圆角半径同档，再往里就压到圆角的弧上；它不跟正文那条居中列缩进。「自动化」
 * 可点即返回列表，悬停时带一块底色，点得到才看得出来。
 */
function EditorBreadcrumb({
  automation,
  onBack,
  saving,
}: {
  readonly automation: Automation | null
  readonly onBack: () => void
  readonly saving: boolean
}) {
  return (
    <nav className="flex items-center gap-1 px-2 pt-2 text-sm">
      <button
        className="rounded-md px-2 py-1 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground disabled:opacity-50"
        disabled={saving}
        onClick={onBack}
        type="button"
      >
        自动化
      </button>
      <ChevronRight aria-hidden className="size-3.5 text-muted-foreground/60" />
      <span className="truncate text-foreground">{automation === null ? '新建任务' : automation.title}</span>
    </nav>
  )
}

function Field({
  aside,
  children,
  htmlFor,
  label,
}: {
  /* 标题行右侧的旁注，如「调度」右边的下一次运行时间。基线对齐，超长省略。 */
  readonly aside?: ReactNode
  readonly children: ReactNode
  readonly htmlFor?: string
  readonly label: string
}) {
  return (
    <section>
      <div className="flex items-baseline justify-between gap-3">
        {htmlFor === undefined ? (
          <h2 className="text-sm font-medium text-foreground">{label}</h2>
        ) : (
          <label className="text-sm font-medium text-foreground" htmlFor={htmlFor}>
            {label}
          </label>
        )}
        {aside === undefined ? null : <div className="min-w-0 truncate text-xs text-muted-foreground">{aside}</div>}
      </div>
      <div className="mt-2">{children}</div>
    </section>
  )
}

/* 「状态」字段：胶囊与右边的滑块说的是同一件事 —— 这条任务开不开。 */
function StatusField({
  enabled,
  hasSchedule,
  onToggleEnabled,
}: {
  readonly enabled: boolean
  readonly hasSchedule: boolean
  readonly onToggleEnabled: (enabled: boolean) => void
}) {
  return (
    <Field label="状态">
      <div className="flex items-center gap-3">
        <StatusBadge enabled={enabled} />
        {hasSchedule ? (
          <div className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
            <span id="automation-enabled-label">启用周期任务</span>
            <Switch aria-labelledby="automation-enabled-label" checked={enabled} onCheckedChange={onToggleEnabled} />
          </div>
        ) : null}
      </div>
    </Field>
  )
}

/*
 * 胶囊只有两档：任务开着是「运行中」，关掉是「已暂停」。
 *
 * 读的是这一页的开关值，不是落盘的那一份 —— 胶囊与开关在同一行，说的是同一件事；
 * 拨了开关而胶囊不动，屏幕上就同时挂着两个状态。
 */
function StatusBadge({ enabled }: { readonly enabled: boolean }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-lg bg-sidebar-accent px-3 py-1.5 text-xs">
      <span aria-hidden className={cn('size-1.5 rounded-full', enabled ? 'bg-success' : 'bg-muted-foreground')} />
      {enabled ? '运行中' : '已暂停'}
    </span>
  )
}

/*
 * 视图切换与提交键同一行：左边切「设置 / 历史」，右边是这一页的动作。
 * 提交键在 form 外面，靠 form 属性把这一页的字段一起交出去。
 * 「立即运行」跑的是已保存的版本，草稿未落盘时它不可点；暂停与删除收进省略号菜单。
 */
function EditorToolbar({
  active,
  automation,
  dirty,
  enabled,
  hasSchedule,
  onDelete,
  onToggleEnabled,
  onViewChange,
  ready,
  saving,
  store,
  view,
}: {
  readonly active: ReturnType<typeof activeRun>
  readonly automation: Automation | null
  readonly dirty: boolean
  readonly enabled: boolean
  readonly hasSchedule: boolean
  readonly onDelete: () => void
  readonly onToggleEnabled: (enabled: boolean) => void
  readonly onViewChange: (view: EditorView) => void
  readonly ready: boolean
  readonly saving: boolean
  readonly store: AutomationsStore
  readonly view: EditorView
}) {
  /* 与列表页「创建定时任务」同一张脸：最高对比的一档，白底反字。 */
  const submitClassName = 'bg-foreground text-background hover:opacity-90'
  return (
    <div className="mt-6 flex items-center gap-3">
      <SegmentedControl
        label="自动化编辑视图"
        name="automation-editor-view"
        onValueChange={onViewChange}
        options={EDITOR_VIEWS}
        value={view}
      />
      <div className="ml-auto flex items-center gap-2">
        {automation === null ? (
          <Button
            className={submitClassName}
            disabled={!ready || !dirty || saving}
            form={FORM_ID}
            size="sm"
            type="submit"
          >
            {saving ? '保存中…' : '创建定时任务'}
          </Button>
        ) : (
          <>
            <Button disabled={!ready || !dirty || saving} form={FORM_ID} size="sm" type="submit" variant="soft">
              {saving ? '保存中…' : '保存'}
            </Button>
            <Button
              disabled={saving || dirty || active !== null}
              onClick={() => {
                void store.runNow(automation.id)
              }}
              size="sm"
              type="button"
              variant="soft"
            >
              立即运行
            </Button>
            <DropdownMenu>
              {/* 方块与左边两颗同高：size="sm" 给高，宽度收回 32px。 */}
              <DropdownMenuTrigger
                aria-label="更多操作"
                render={<Button className="w-8 px-0" size="sm" type="button" variant="soft" />}
              >
                <Ellipsis aria-hidden className="size-3.5" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                {hasSchedule ? (
                  <DropdownMenuItem
                    onClick={() => {
                      onToggleEnabled(!enabled)
                    }}
                  >
                    {enabled ? (
                      <CirclePause aria-hidden className="size-3.5" />
                    ) : (
                      <CirclePlay aria-hidden className="size-3.5" />
                    )}
                    {enabled ? '暂停' : '启用'}
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuSeparator />
                <DropdownMenuItem className="text-destructive" disabled={active !== null} onClick={onDelete}>
                  <Trash aria-hidden className="size-3.5" />
                  删除
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}
      </div>
    </div>
  )
}

/*
 * 两枚确认框：删除与放弃草稿。
 *
 * legacy 还有第三枚「用当前草稿编辑最新版本？」—— 随 revision 一起取消（见 EditorAlerts）。
 */
function EditorDialogs({
  automation,
  confirmingBack,
  confirmingDelete,
  onBack,
  setConfirmingBack,
  setConfirmingDelete,
  store,
}: {
  readonly automation: Automation | null
  readonly confirmingBack: boolean
  readonly confirmingDelete: boolean
  readonly onBack: () => void
  readonly setConfirmingBack: (open: boolean) => void
  readonly setConfirmingDelete: (open: boolean) => void
  readonly store: AutomationsStore
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

/* ── 运行方式（审查 R-16）：对话、通知、错过补跑 ─────────────────────────── */

const THREAD_OPTIONS = [
  { value: 'new', label: '每次新开对话' },
  { value: 'continue', label: '续用同一条对话' },
] as const satisfies readonly SegmentedOption<ThreadMode>[]

const NOTIFY_OPTIONS = [
  { value: 'attention', label: '需要关注时' },
  { value: 'always', label: '每次' },
  { value: 'never', label: '从不' },
] as const satisfies readonly SegmentedOption<NotifyPolicy>[]

const THREAD_HELP: Readonly<Record<ThreadMode, string>> = {
  new: '每次运行开一条新对话，互不影响。',
  continue:
    '第一次运行新建一条对话，之后每次都回到这条对话里接着跑，带着之前的上下文。模型与权限跟随那条对话；那条对话正忙时，这一次会跳过并记一笔。',
}

const NOTIFY_HELP: Readonly<Record<NotifyPolicy, string>> = {
  attention: '失败、等待你批准、超时，或 agent 汇报需要你看时，发系统通知。',
  always: '每次运行结束都发系统通知。',
  never: '不发系统通知；结果只记在历史里。',
}

function OptionRow({
  children,
  help,
  label,
}: {
  readonly children: ReactNode
  readonly help: ReactNode
  readonly label: string
}) {
  return (
    <div className="flex flex-col gap-1.5 px-4 py-3">
      <div className="flex items-center gap-3">
        <span className="text-xs text-foreground">{label}</span>
        <div className="ml-auto">{children}</div>
      </div>
      <p className="text-xs leading-5 text-muted-foreground">{help}</p>
    </div>
  )
}

function RunOptionsField({
  catchUp,
  hasSchedule,
  notify,
  onCatchUpChange,
  onNotifyChange,
  onOpenThread,
  onThreadModeChange,
  threadId,
  threadMode,
}: {
  readonly catchUp: boolean
  readonly hasSchedule: boolean
  readonly notify: NotifyPolicy
  readonly onCatchUpChange: (catchUp: boolean) => void
  readonly onNotifyChange: (notify: NotifyPolicy) => void
  readonly onOpenThread: (threadId: string) => void
  readonly onThreadModeChange: (mode: ThreadMode) => void
  readonly threadId: string | null
  readonly threadMode: ThreadMode
}) {
  return (
    <Field label="运行方式">
      <div className="divide-y divide-divider/60 rounded-xl border border-divider bg-popover">
        <OptionRow
          help={
            <>
              {THREAD_HELP[threadMode]}
              {threadMode === 'continue' && threadId !== null ? (
                <button
                  className="ml-1 text-foreground hover:underline"
                  onClick={() => onOpenThread(threadId)}
                  type="button"
                >
                  打开这条对话
                </button>
              ) : null}
            </>
          }
          label="对话"
        >
          <SegmentedControl
            label="对话方式"
            name="automation-thread-mode"
            onValueChange={onThreadModeChange}
            options={THREAD_OPTIONS}
            value={threadMode}
          />
        </OptionRow>
        <OptionRow help={NOTIFY_HELP[notify]} label="通知">
          <SegmentedControl
            label="通知"
            name="automation-notify"
            onValueChange={onNotifyChange}
            options={NOTIFY_OPTIONS}
            value={notify}
          />
        </OptionRow>
        {hasSchedule ? (
          <OptionRow help="应用没开着时错过的那一次，下次启动后补跑一次（错过多次也只补一次）。" label="错过补跑">
            <Switch aria-label="错过补跑" checked={catchUp} onCheckedChange={onCatchUpChange} />
          </OptionRow>
        ) : null}
      </div>
    </Field>
  )
}

/** 控件表 → 编辑器要的可选项：模型表与默认模型读不带模型的那份，档位读选中模型那份 */
function choicesOf(base: Controls, picked: Controls | null): ModelChoices {
  const models = base.model.choices.map((c) => ({ ref: c.ref, label: c.label }))
  const current = base.model.current
  const defaultLabel =
    current === null
      ? null
      : (models.find((m) => m.ref.provider === current.provider && m.ref.id === current.id)?.label ?? current.id)
  return { models, defaultLabel, thinking: (picked ?? base).thinking.choices }
}

/* 读可选项：模型一变就重读档位。读失败给空表（控件仍可用，只是只剩「默认」）。 */
function useModelChoices(store: AutomationsStore, model: ModelRef | null): ModelChoices | null {
  const [choices, setChoices] = useState<ModelChoices | null>(null)
  const provider = model?.provider ?? null
  const id = model?.id ?? null
  useEffect(() => {
    let disposed = false
    const picked = provider === null || id === null ? null : { provider, id }
    void Promise.all([store.draftControls(null), picked === null ? null : store.draftControls(picked)]).then(
      ([base, forModel]) => {
        if (!disposed) setChoices(choicesOf(base, forModel))
      },
      () => {
        if (!disposed) setChoices({ models: [], defaultLabel: null, thinking: [] })
      },
    )
    return () => {
      disposed = true
    }
  }, [store, provider, id])
  return choices
}

const scheduleKey = (schedule: ScheduleValue): string => `${schedule.cron ?? ''}|${schedule.at ?? ''}`

interface PreviewState {
  readonly key: string
  readonly preview: { readonly times: readonly number[]; readonly problem: ScheduleProblem | null } | null
  readonly error: string | null
}

export function AutomationEditor({
  automation,
  draft,
  runs,
  store,
  workspaceChoices,
  onBack,
  pickWorkspace,
  onOpenThread,
}: AutomationEditorProps) {
  const [baselineDraft] = useState(draft)
  const [enabled, setEnabled] = useState(automation?.enabled ?? true)
  const [title, setTitle] = useState(draft.title)
  const [prompt, setPrompt] = useState(draft.prompt)
  const [schedule, setSchedule] = useState<ScheduleValue>({ cron: draft.schedule.cron, at: draft.schedule.at })
  const [posture, setPosture] = useState(draft.posture)
  const [model, setModel] = useState(draft.model)
  const [thinking, setThinking] = useState(draft.thinking)
  const [threadMode, setThreadMode] = useState(draft.threadMode)
  const [notify, setNotify] = useState(draft.notify)
  const [catchUp, setCatchUp] = useState(draft.catchUp)
  const [workspaceId, setWorkspaceId] = useState(draft.workspaceId)
  const [saving, setSaving] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [confirmingBack, setConfirmingBack] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  const [previewState, setPreviewState] = useState<PreviewState | null>(null)
  const [view, setView] = useState<EditorView>('settings')
  const storeError = useFeatureStore(store.store, (held) => held.error)
  const choices = useModelChoices(store, model)
  const { cron, at } = schedule
  const hasSchedule = cron !== null || at !== null

  /* 时区不由界面给：任务一律按系统时区跑，编辑器只读草稿里那一份。 */
  const timeZone = draft.schedule.timeZone
  const next: AutomationDraft = useMemo(
    () => ({
      title: title.trim(),
      prompt: prompt.trim(),
      schedule: { cron, at, timeZone },
      workspaceId,
      posture,
      model,
      thinking,
      threadMode,
      /* 续用的那条对话由 Core 记；改成「每次新开」就忘掉它，切回续用时第一次运行再新建 */
      threadId: threadMode === 'new' ? null : baselineDraft.threadId,
      notify,
      catchUp,
    }),
    [
      baselineDraft,
      at,
      catchUp,
      cron,
      model,
      notify,
      posture,
      prompt,
      thinking,
      threadMode,
      timeZone,
      title,
      workspaceId,
    ],
  )
  const dirty = automation === null || !sameDraft(next, baselineDraft)
  const key = scheduleKey(schedule)
  const previewMatches = previewState?.key === key
  const preview = previewMatches ? previewState.preview : null
  const previewError = previewMatches ? previewState.error : null
  const ready =
    title.trim() !== '' &&
    prompt.trim() !== '' &&
    workspaceId.trim() !== '' &&
    preview !== null &&
    preview.problem === null
  const currentWorkspace = workspaceChoiceOf(workspaceId, workspaceChoices)
  const active = activeRun(runs)

  /* 输入停止 300ms 后请求预览（07 页 §9E）；超时请求作废的方式是清掉定时器。 */
  useEffect(() => {
    let disposed = false
    const timer = setTimeout(() => {
      void store.preview({ cron, at, timeZone }, 5).then(
        (result) => {
          if (!disposed) {
            setPreviewState({ key: scheduleKey({ cron, at }), preview: result, error: null })
          }
        },
        (cause: unknown) => {
          if (!disposed) {
            setPreviewState({
              key: scheduleKey({ cron, at }),
              preview: null,
              error: cause instanceof Error ? cause.message : String(cause),
            })
          }
        },
      )
    }, 300)
    return () => {
      disposed = true
      clearTimeout(timer)
    }
  }, [store, cron, at, timeZone])

  async function chooseWorkspace(): Promise<void> {
    try {
      const selected = await pickWorkspace()
      if (selected !== null) {
        setWorkspaceId(selected)
        setLocalError(null)
      }
    } catch (cause: unknown) {
      setLocalError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  async function save(): Promise<void> {
    if (!ready || !dirty || saving) {
      return
    }
    setSaving(true)
    setLocalError(null)
    try {
      const saved = automation === null ? await store.create(next) : await store.update(automation.id, next, enabled)
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

  return (
    <div className="flex h-full flex-col overflow-y-auto bg-ground">
      {/* 面包屑是这一页的家具，坐左上角；正文那条居中列从它下面起。 */}
      <EditorBreadcrumb automation={automation} onBack={requestBack} saving={saving} />
      <div className="mx-auto w-full max-w-3xl px-8 pb-16">
        <h1 className="mt-6 text-2xl font-semibold tracking-tight">
          {automation === null ? '新建定时任务' : '编辑定时任务'}
        </h1>
        <p className="mt-2 text-xs leading-5 text-muted-foreground">配置任务的执行时间、指令和运行方式。</p>
        <EditorToolbar
          active={active}
          automation={automation}
          dirty={dirty}
          enabled={enabled}
          hasSchedule={hasSchedule}
          onDelete={() => {
            setConfirmingDelete(true)
          }}
          onToggleEnabled={setEnabled}
          onViewChange={setView}
          ready={ready}
          saving={saving}
          store={store}
          view={view}
        />
        <div className="mt-8">
          <EditorAlerts issue={automation?.issue ?? null} message={localError ?? storeError} />
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
              {automation === null ? null : (
                <StatusField enabled={enabled} hasSchedule={hasSchedule} onToggleEnabled={setEnabled} />
              )}
              <Field htmlFor="automation-title" label="任务标题">
                {/* 底与「添加计划」同读 --ui-popover；焦点不换框色、不画环。 */}
                <input
                  autoComplete="off"
                  className="h-11 w-full rounded-xl border border-divider bg-popover px-4 text-sm outline-none"
                  id="automation-title"
                  onChange={(event) => setTitle(event.currentTarget.value)}
                  placeholder="未命名定时任务"
                  value={title}
                />
              </Field>
              <Field aside={hasSchedule ? statusText(preview) : undefined} label="调度">
                <AutomationScheduleField
                  error={previewError}
                  onChange={setSchedule}
                  preview={preview}
                  schedule={schedule}
                />
              </Field>
              <Field label="指令">
                {/*
                这里放的就是编辑器的指令输入框本身：同一张卡、同一排工具条。它没有收信人
                （不给 onSubmit），所以没有发送键、Enter 只换行 —— 它的提交键是页头那颗。
                正文经 onPromptChange 回到 prompt 那一格，与别的字段没有分别。

                「在哪跑」跟着这张卡走：工作目录是执行上下文，而执行上下文一直长在输入框
                下沿（见 automation-composer.css 的 .composer-context）。
                */}
                <div className="flex flex-col" data-assistant-skin>
                  <AutomationComposer
                    choices={choices}
                    model={model}
                    onModelChange={(picked) => {
                      setModel(picked)
                      /* 档位是模型的：换了模型，原来那一档不一定还在，回到「默认」 */
                      setThinking(null)
                    }}
                    onPostureChange={setPosture}
                    onThinkingChange={setThinking}
                    thinking={thinking}
                    onPromptChange={setPrompt}
                    placeholder="到期时发给 agent 的指令"
                    posture={posture}
                    prompt={prompt}
                  />

                  <div className="composer-context">
                    <WorkspacePicker
                      choices={workspaceChoices}
                      current={currentWorkspace}
                      onBrowse={() => {
                        void chooseWorkspace()
                      }}
                      onChoose={setWorkspaceId}
                      placement="composer"
                    />
                  </div>
                </div>
              </Field>
              <RunOptionsField
                catchUp={catchUp}
                hasSchedule={hasSchedule}
                notify={notify}
                onCatchUpChange={setCatchUp}
                onNotifyChange={setNotify}
                onOpenThread={onOpenThread}
                onThreadModeChange={setThreadMode}
                threadId={baselineDraft.threadId}
                threadMode={threadMode}
              />
            </form>
          ) : null}
          {view === 'runs' ? (
            <AutomationRunHistory
              onCancel={(runId) => {
                void store.cancel(runId)
              }}
              onOpenThread={(threadId) => {
                onOpenThread(threadId)
              }}
              runs={runs}
              title={automation?.title ?? title}
            />
          ) : null}
        </div>
      </div>
      <EditorDialogs
        automation={automation}
        confirmingBack={confirmingBack}
        confirmingDelete={confirmingDelete}
        onBack={onBack}
        setConfirmingBack={setConfirmingBack}
        setConfirmingDelete={setConfirmingDelete}
        store={store}
      />
    </div>
  )
}
