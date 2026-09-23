import {
  ConfirmationDialog,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Switch,
} from '@poietica/design-system'
import {
  ChevronDown,
  CirclePlay,
  Clock,
  Ellipsis,
  Info,
  Pause,
  Pencil,
  Play,
  RefreshCw,
  Square,
  Trash,
} from 'lucide-react'
import { useState } from 'react'
import {
  AUTOMATION_TEMPLATES,
  type Automation,
  type AutomationStore,
  type AutomationTemplate,
  activeRun,
  describeMoment,
  describeSchedule,
  latestRun,
} from '../index'

export interface AutomationListProps {
  readonly automations: readonly Automation[]
  readonly pending: readonly string[]
  readonly onCreateBlank: () => void
  readonly onOpen: (automationId: string) => void
  readonly onPickTemplate: (template: AutomationTemplate) => void
  readonly store: AutomationStore
}

const STATUS_FILTERS = ['全部', '进行中', '已完成', '失败'] as const

type StatusFilter = (typeof STATUS_FILTERS)[number]

/*
 * 筛选只看最近一次运行：没跑过的任务既不是「已完成」也不是「失败」，只在「全部」里
 * 出现。运行中另立一档，它与最近一次已经落定的结果无关。
 */
function matchesFilter(automation: Automation, filter: StatusFilter): boolean {
  if (filter === '全部') {
    return true
  }
  if (filter === '进行中') {
    return activeRun(automation) !== null
  }
  const run = latestRun(automation)
  return filter === '已完成' ? run?.outcome === 'succeeded' : run?.outcome === 'failed'
}

export function AutomationList({
  automations,
  pending,
  onCreateBlank,
  onOpen,
  onPickTemplate,
  store,
}: AutomationListProps) {
  const [filter, setFilter] = useState<StatusFilter>('全部')
  const [deleting, setDeleting] = useState<Automation | null>(null)
  const visible = automations.filter((automation) => matchesFilter(automation, filter))
  return (
    <>
      {automations.length === 0 ? (
        <>
          <div className="mt-8 flex flex-col items-center justify-center gap-5 rounded-2xl border border-divider px-6 py-16">
            <p className="text-xs text-muted-foreground">还没有定时任务</p>
            <CreateMenu onCreateBlank={onCreateBlank} onPickTemplate={onPickTemplate} />
          </div>
          <KeepAwakeRow />
        </>
      ) : (
        <>
          <div className="mt-6 flex items-center gap-2">
            <span className="rounded-lg bg-sidebar-accent px-3 py-1.5 text-xs font-medium">
              定时任务
            </span>
            <button
              aria-label="刷新自动化目录"
              className="ml-auto inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
              onClick={() => {
                void store.refresh()
              }}
              type="button"
            >
              <RefreshCw aria-hidden className="size-3.5" />
            </button>
            <CreateMenu onCreateBlank={onCreateBlank} onPickTemplate={onPickTemplate} />
          </div>

          <div className="mt-3 flex gap-1">
            {STATUS_FILTERS.map((tab) => (
              <button
                aria-pressed={tab === filter}
                className={cn(
                  'rounded-md px-2.5 py-1 text-xs transition-colors',
                  tab === filter
                    ? 'bg-sidebar-accent text-foreground'
                    : 'text-muted-foreground hover:bg-sidebar-accent/60',
                )}
                key={tab}
                onClick={() => {
                  setFilter(tab)
                }}
                type="button"
              >
                {tab}
              </button>
            ))}
          </div>

          <KeepAwakeRow />

          <h2 className="mt-6 text-xs text-muted-foreground">已创建任务</h2>
          {visible.length === 0 ? (
            <p className="py-10 text-center text-xs text-muted-foreground">这个筛选下没有任务</p>
          ) : (
            <ul className="mt-3 grid grid-cols-2 gap-3">
              {visible.map((automation) => (
                <TaskCard
                  automation={automation}
                  key={automation.id}
                  onDelete={setDeleting}
                  onOpen={onOpen}
                  pending={pending}
                  store={store}
                />
              ))}
            </ul>
          )}
        </>
      )}

      <ConfirmationDialog
        confirmLabel="删除"
        description="删除任务定义及保留的运行索引。已有对话内容不会删除。"
        destructive
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting !== null) {
            void store.remove(deleting.id).then((removed) => {
              if (removed) {
                setDeleting(null)
              }
            })
          }
        }}
        open={deleting !== null}
        title="删除这条自动化？"
      />
    </>
  )
}

function TaskCard({
  automation,
  onDelete,
  onOpen,
  pending,
  store,
}: {
  readonly automation: Automation
  readonly onDelete: (automation: Automation) => void
  readonly onOpen: (automationId: string) => void
  readonly pending: readonly string[]
  readonly store: AutomationStore
}) {
  const active = activeRun(automation)
  const busy = pending.some(
    (key) => key.endsWith(`:${automation.id}`) || key === `cancel:${active?.id}`,
  )
  const paused = automation.schedule !== null && !automation.enabled
  const schedule = describeSchedule(automation.schedule)
  const line = paused
    ? `${schedule} · 已暂停`
    : automation.nextRunAt === null
      ? schedule
      : `${schedule} · 下次运行 ${describeMoment(automation.nextRunAt)}`
  return (
    <li className="flex">
      <article className="flex w-full flex-col rounded-xl border border-divider bg-[var(--ui-card)] px-4 py-3.5">
        <div className="flex items-start gap-2">
          <h3 className="min-w-0 flex-1 text-xs font-medium">{automation.title}</h3>
          <TaskMenu
            active={active}
            automation={automation}
            busy={busy}
            onDelete={onDelete}
            onOpen={onOpen}
            store={store}
          />
        </div>

        <p className="mt-1.5 line-clamp-2 text-xs leading-5 text-muted-foreground">
          {automation.prompt}
        </p>

        {automation.issue ? (
          <p className="mt-1.5 text-xs text-destructive">{automation.issue}</p>
        ) : null}

        <div className="mt-auto flex items-center gap-2 pt-3 text-xs">
          <span
            className={cn(
              'flex min-w-0 items-center gap-1.5',
              paused ? 'text-muted-foreground' : 'text-success',
            )}
          >
            <Clock aria-hidden className="size-3.5 shrink-0" />
            <span className="truncate">{line}</span>
          </span>
          <span className="ml-auto shrink-0 rounded-md bg-sidebar-accent px-2 py-0.5 text-muted-foreground">
            已运行 {automation.runs.length} 次
          </span>
        </div>
      </article>
    </li>
  )
}

/*
 * 一行任务的全部动作收进卡片右上角这一个菜单：表格时代它们各占一栏，卡片放不下，
 * 而「立即运行 / 暂停 / 编辑 / 删除」本来就是同一件事的四种走向。
 */
function TaskMenu({
  active,
  automation,
  busy,
  onDelete,
  onOpen,
  store,
}: {
  readonly active: ReturnType<typeof activeRun>
  readonly automation: Automation
  readonly busy: boolean
  readonly onDelete: (automation: Automation) => void
  readonly onOpen: (automationId: string) => void
  readonly store: AutomationStore
}) {
  const cancelling = active?.outcome === 'cancelling'
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`${automation.title}的操作`}
        className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground"
        type="button"
      >
        <Ellipsis aria-hidden className="size-3.5" />
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-44">
        {active === null ? (
          <DropdownMenuItem
            disabled={busy}
            onClick={() => {
              void store.runNow(automation.id)
            }}
          >
            <Play aria-hidden className="size-3.5" />
            立即运行
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem
            disabled={busy || cancelling}
            onClick={() => {
              void store.cancel(active.id)
            }}
          >
            <Square aria-hidden className="size-3.5" />
            {cancelling ? '停止待确认' : '停止运行'}
          </DropdownMenuItem>
        )}

        {automation.schedule === null ? null : (
          <DropdownMenuItem
            disabled={busy}
            onClick={() => {
              void store.setEnabled(automation.id, automation.revision, !automation.enabled)
            }}
          >
            {automation.enabled ? (
              <Pause aria-hidden className="size-3.5" />
            ) : (
              <CirclePlay aria-hidden className="size-3.5" />
            )}
            {automation.enabled ? '暂停' : '启用'}
          </DropdownMenuItem>
        )}

        <DropdownMenuItem
          disabled={busy}
          onClick={() => {
            onOpen(automation.id)
          }}
        >
          <Pencil aria-hidden className="size-3.5" />
          编辑定时任务
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        <DropdownMenuItem
          className="text-destructive"
          disabled={busy || active !== null}
          onClick={() => {
            onDelete(automation)
          }}
        >
          <Trash aria-hidden className="size-3.5" />
          删除
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/* 空态那张大卡片中央的白按钮，与有任务时工具栏右侧那颗，用的是同一个菜单。 */
function CreateMenu({
  onCreateBlank,
  onPickTemplate,
}: {
  readonly onCreateBlank: () => void
  readonly onPickTemplate: (template: AutomationTemplate) => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="inline-flex items-center gap-1.5 rounded-lg bg-foreground px-4 py-2 text-xs font-medium text-background transition-opacity hover:opacity-90"
        type="button"
      >
        创建定时任务
        <ChevronDown aria-hidden className="size-3.5 opacity-70" />
      </DropdownMenuTrigger>

      <DropdownMenuContent className="w-56">
        <DropdownMenuItem onClick={onCreateBlank}>空白任务</DropdownMenuItem>
        <DropdownMenuSeparator />
        {AUTOMATION_TEMPLATES.map((template) => (
          <DropdownMenuItem
            key={template.id}
            onClick={() => {
              onPickTemplate(template)
            }}
          >
            {template.title}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/*
 * ponytail: 这一行目前只是界面。仓库里没有任何电源管理能力（Rust 侧与前端都搜不到
 * prevent_sleep 之类），开关切了不改变任何行为。接上真实的防休眠命令之前，别把
 * 它当成能用的开关。
 */
function KeepAwakeRow() {
  const [keepAwake, setKeepAwake] = useState(false)
  return (
    <div className="mt-5 flex items-center gap-2 rounded-2xl border border-divider px-5 py-3.5">
      <Info aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="text-xs text-muted-foreground">运行会话时保持电脑唤醒</span>
      <Switch
        aria-label="运行会话时保持电脑唤醒"
        checked={keepAwake}
        className="ml-auto"
        onCheckedChange={setKeepAwake}
      />
    </div>
  )
}
