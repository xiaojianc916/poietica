import type { SessionConfigControl } from '@poietica/agent-contract'
import type { Automation } from '@poietica/ipc'
import { ArrowLeftIcon, ConfirmationDialog, cn, PlayIcon } from '@poietica/ui'
import { type ReactNode, useMemo, useState } from 'react'

import { type AutomationDraft, sameSessionConfig } from '../automation'
import type { AutomationStore } from '../automation-store'
import { AutomationRunHistory } from './automation-run-history'
import { AutomationScheduleField } from './automation-schedule-field'
import { AutomationSessionConfig } from './automation-session-config'

/*
 * 一条自动化的整页编辑器。
 *
 * 头部没有横线。那条 border-b 是全宽的，而正文是居中的 max-w-2xl —— 一条横线
 * 横穿整个窗口、下面的内容却只占中间一段，读起来是「这条线属于窗口」而不是
 * 「属于这一页」。
 *
 * 页签是胶囊，不是下划线：下划线暗示「这是一层导航」，而设置与运行历史是同一个
 * 对象的两个视图。
 *
 * 三颗会话胶囊贴在指令框底部，不单独占一张卡片 —— 本仓库自己的输入框就是这么
 * 排的（agent-ui 的 session-controls）。它们回答的是「这段话由谁来跑」，那是指令
 * 的属性，不是与指令并列的另一件事。
 */

export interface AutomationEditorProps {
  /** 已经存在的那一条；新建时为 null。它只提供身份：id、运行记录、能不能试运行。 */
  readonly automation: Automation | null
  /**
   * 这一家 agent 此刻报出来的可调项。
   *
   * 由 apps/desktop 读了交进来（见 automations/automations-view.tsx）：这一层与
   * @poietica/agent-ui 同层，不能横向去拿，它只认识这份数据的形状。
   */
  readonly controls: readonly SessionConfigControl[]
  /**
   * 打开这一屏时表单里应该有的东西。
   *
   * 编辑已有的那条时是 draftOf(automation)，从模板进来时是模板那一份，直接
   * 新建时是 BLANK_DRAFT。三个入口一个初值通道 —— 少了它，「模板预填」就会
   * 变成编辑器内部的第二套初始化分支。
   */
  readonly draft: AutomationDraft
  readonly onBack: () => void
  readonly store: AutomationStore
}

type EditorTab = 'settings' | 'runs'

const TABS: readonly { readonly id: EditorTab; readonly label: string }[] = [
  { id: 'settings', label: '设置' },
  { id: 'runs', label: '运行历史' },
]

/**
 * 这条自动化最终要存下去的那一份会话设置。
 *
 * 人没动过的项，取 agent 此刻报的 current —— 那正是界面上显示的组合。所见即
 * 所存，不留「未选择」这种第三态。
 *
 * 先铺 picked、再用 controls 覆盖，顺序不能反：agent 这一刻没报的项照样留在盘
 * 上，不因为人打开过一次编辑器就被静默抹掉。
 */
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

export function AutomationEditor({
  automation,
  controls,
  draft,
  onBack,
  store,
}: AutomationEditorProps) {
  const [tab, setTab] = useState<EditorTab>('settings')
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [title, setTitle] = useState(draft.title)
  const [prompt, setPrompt] = useState(draft.prompt)
  const [schedule, setSchedule] = useState<string | null>(draft.schedule)
  const [picked, setPicked] = useState<Record<string, string>>(() => ({ ...draft.sessionConfig }))

  const sessionConfig = useMemo(() => resolve(picked, controls), [controls, picked])

  const runs = automation?.runs ?? []
  const ready = title.trim().length > 0 && prompt.trim().length > 0

  /*
   * 基准是「打开这一屏时表单里的那一份」，不是 automation 上的字段。
   *
   * 对已有的那条来说两者等价（draft 就是 draftOf(automation)），但只有前者
   * 说得清模板预填：那一份没有对应的 automation，却确实有一个初始状态。
   */
  const dirty =
    automation === null ||
    title !== draft.title ||
    prompt !== draft.prompt ||
    draft.schedule !== schedule ||
    !sameSessionConfig(draft.sessionConfig, sessionConfig)

  function choose(controlId: string, value: string): void {
    setPicked((current) => ({ ...current, [controlId]: value }))
  }

  function save(): void {
    const next = { prompt: prompt.trim(), schedule, sessionConfig, title: title.trim() }

    if (automation === null) {
      store.create(next)
    } else {
      store.update(automation.id, next)
    }

    onBack()
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto bg-ground">
      <header className="sticky top-0 z-10 flex items-center justify-between gap-3 bg-ground px-8 py-3">
        <IconButton label="返回自动化列表" onClick={onBack}>
          <ArrowLeftIcon className="size-4" />
        </IconButton>

        <div className="flex items-center gap-1">
          {/*
            草稿没有 id，runNow 无从点名，所以按钮禁用而不是假装能跑。
            标题直说原因 —— 一颗不说明理由的灰按钮是死路。
          */}
          <IconButton
            disabled={automation === null}
            label={automation === null ? '先保存才能试运行' : '试运行'}
            onClick={() => {
              if (automation !== null) {
                store.runNow(automation.id)
              }
            }}
          >
            <PlayIcon className="size-4" />
          </IconButton>

          {automation === null ? null : (
            <button
              className="rounded-md px-2.5 py-1.5 text-xs text-destructive transition-colors hover:bg-sidebar-accent"
              onClick={() => {
                setConfirmingDelete(true)
              }}
              type="button"
            >
              删除
            </button>
          )}

          <button
            className="rounded-md bg-foreground px-3 py-1.5 text-xs text-ground transition-opacity disabled:pointer-events-none disabled:opacity-40"
            disabled={!ready || !dirty}
            onClick={save}
            type="button"
          >
            保存
          </button>
        </div>
      </header>

      <div className="mx-auto w-full max-w-2xl px-8 pb-16">
        <input
          aria-label="自动化名称"
          className="w-full bg-transparent text-2xl font-medium tracking-tight text-foreground outline-none placeholder:text-placeholder"
          onChange={(event) => {
            setTitle(event.target.value)
          }}
          placeholder="未命名"
          value={title}
        />

        <div className="mt-5 flex gap-1">
          {TABS.map((entry) => (
            <button
              aria-current={tab === entry.id ? 'page' : undefined}
              className={cn(
                'rounded-full px-3 py-1 text-xs transition-colors',
                tab === entry.id
                  ? 'bg-sidebar-accent text-foreground'
                  : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground',
              )}
              key={entry.id}
              onClick={() => {
                setTab(entry.id)
              }}
              type="button"
            >
              {entry.label}

              {entry.id === 'runs' && runs.length > 0 ? (
                <span className="ml-1.5 tabular-nums opacity-60">{runs.length}</span>
              ) : null}
            </button>
          ))}
        </div>

        {tab === 'runs' ? (
          <div className="mt-5">
            <AutomationRunHistory runs={runs} />
          </div>
        ) : (
          <div className="mt-5 flex flex-col gap-3">
            <Card hint="决定它什么时候自己跑起来" title="触发">
              <div className="px-4 py-4">
                <AutomationScheduleField onChange={setSchedule} schedule={schedule} />
              </div>
            </Card>

            <Card hint="每次到期，就把这段话发给 agent，跑在一条新开的对话里" title="指令">
              <textarea
                aria-label="指令"
                className="min-h-44 w-full resize-y bg-transparent px-4 py-3 text-sm leading-6 text-foreground outline-none placeholder:text-placeholder"
                onChange={(event) => {
                  setPrompt(event.target.value)
                }}
                placeholder="到期时发给 agent 的那句话"
                value={prompt}
              />

              <div className="flex flex-wrap items-center gap-1 border-t border-divider/60 px-2.5 py-2">
                <AutomationSessionConfig controls={controls} onChange={choose} value={picked} />
              </div>
            </Card>
          </div>
        )}
      </div>

      {/* 删除不可撤销（定义与运行记录一起没），最后一步经确认，不直接落锤。 */}
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
    </div>
  )
}

function IconButton({
  children,
  disabled,
  label,
  onClick,
}: {
  readonly children: ReactNode
  readonly disabled?: boolean
  readonly label: string
  readonly onClick: () => void
}) {
  return (
    <button
      aria-label={label}
      className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
      disabled={disabled}
      onClick={onClick}
      title={label}
      type="button"
    >
      {children}
    </button>
  )
}

/*
 * 卡片自己不给正文留内边距。
 *
 * 指令那张卡片的正文是「文本域 + 控件条」，两段各自贴边、中间一条分隔线；
 * 触发那张是普通内容。与其加一个 bodyClassName 开关，不如让调用点自己写那
 * 一层 div —— 开关会长大，div 不会。
 */
function Card({
  children,
  hint,
  title,
}: {
  readonly children: ReactNode
  readonly hint: string
  readonly title: string
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-divider bg-background">
      <header className="px-4 pb-3 pt-3.5">
        <h2 className="text-xs font-medium text-foreground">{title}</h2>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">{hint}</p>
      </header>

      <div className="border-t border-divider/60">{children}</div>
    </section>
  )
}
