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
import { CirclePlay, Clock, Ellipsis, Info, Pause, Pencil, Play, RefreshCw, Square, Trash } from 'lucide-react'
import { useState } from 'react'
import type { Automation, AutomationRun } from '../contract'
import { activeRun, describeMoment, describePlan, hasPlan, latestRun } from './automation'
import type { AutomationsStore } from './automations-store'

/* 外观照 legacy 逐字迁移。数据来路变了：运行记录不进 Automation 实体，「进行中」与「已运行 N 次」读 store 里按 id 缓存的 runs。
 * 卡片只画任务定义，**不画上一次运行的结论** —— 那句结论是 agent 交的正文，放在卡片上读起来就是一条聊天记录。 */

export interface AutomationListProps {
  readonly automations: readonly Automation[]
  readonly pending: readonly string[]
  readonly runsOf: (automationId: string) => readonly AutomationRun[]
  readonly onCreateBlank: () => void
  readonly onOpen: (automationId: string) => void
  readonly store: AutomationsStore
}

const STATUS_FILTERS = ['全部', '进行中', '已完成', '失败'] as const

type StatusFilter = (typeof STATUS_FILTERS)[number]

function matchesFilter(runs: readonly AutomationRun[], filter: StatusFilter): boolean {
  if (filter === '全部') {
    return true
  }
  if (filter === '进行中') {
    return activeRun(runs) !== null
  }
  const run = latestRun(runs)
  return filter === '已完成' ? run?.outcome === 'succeeded' : run?.outcome === 'failed'
}

export function AutomationList({ automations, pending, runsOf, onCreateBlank, onOpen, store }: AutomationListProps) {
  const [filter, setFilter] = useState<StatusFilter>('全部')
  const [deleting, setDeleting] = useState<Automation | null>(null)
  const visible = automations.filter((automation) => matchesFilter(runsOf(automation.id), filter))
  return (
    <>
      {automations.length === 0 ? (
        <>
          <div className="mt-8 flex flex-col items-center justify-center gap-5 rounded-2xl border px-6 py-16">
            <p className="text-xs text-muted-foreground">还没有定时任务</p>
            <CreateButton onCreateBlank={onCreateBlank} />
          </div>
          <KeepAwakeRow />
        </>
      ) : (
        <>
          <div className="mt-6 flex items-center gap-2">
            <div className="flex gap-1">
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
            <button
              aria-label="刷新自动化目录"
              className="ml-auto inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
              onClick={() => {
                void store.refresh()
              }}
              type="button"
            >
              <RefreshCw aria-hidden />
            </button>
            <CreateButton onCreateBlank={onCreateBlank} />
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
                  runs={runsOf(automation.id)}
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

function planLine(automation: Automation): string {
  const schedule = describePlan(automation.schedule)
  if (automation.schedule.at !== null && !automation.enabled && automation.nextRunAt === null) {
    return `${schedule} · 已结束`
  }
  if (hasPlan(automation.schedule) && !automation.enabled) {
    return `${schedule} · 已暂停`
  }
  return automation.nextRunAt === null ? schedule : `${schedule} · 下次运行 ${describeMoment(automation.nextRunAt)}`
}

function TaskCard({
  automation,
  onDelete,
  onOpen,
  pending,
  runs,
  store,
}: {
  readonly automation: Automation
  readonly onDelete: (automation: Automation) => void
  readonly onOpen: (automationId: string) => void
  readonly pending: readonly string[]
  readonly runs: readonly AutomationRun[]
  readonly store: AutomationsStore
}) {
  const active = activeRun(runs)
  const busy = pending.some((key) => key.endsWith(`:${automation.id}`) || key === `cancel:${active?.id}`)
  const paused = hasPlan(automation.schedule) && !automation.enabled
  const line = planLine(automation)
  return (
    <li className="flex">
      <article className="flex w-full flex-col rounded-xl border bg-[var(--ui-card)] px-4 py-3.5">
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

        <p className="mt-1.5 line-clamp-2 text-xs leading-5 text-muted-foreground">{automation.prompt}</p>

        {automation.issue ? <p className="mt-1.5 text-xs text-destructive">{automation.issue}</p> : null}

        <div className="mt-auto flex items-center gap-2 pt-3 text-xs">
          <span className={cn('flex min-w-0 items-center gap-1.5', paused ? 'text-muted-foreground' : 'text-success')}>
            <Clock aria-hidden />
            <span className="truncate">{line}</span>
          </span>
          <span className="ml-auto rounded-md bg-sidebar-accent px-2 py-0.5 text-muted-foreground">
            已运行 {runs.length} 次
          </span>
        </div>
      </article>
    </li>
  )
}

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
  readonly store: AutomationsStore
}) {
  const cancelling = false
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`${automation.title}的操作`}
        className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground"
        type="button"
      >
        <Ellipsis aria-hidden />
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-44">
        {active === null ? (
          <DropdownMenuItem
            disabled={busy}
            onClick={() => {
              void store.runNow(automation.id)
            }}
          >
            <Play aria-hidden />
            立即运行
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem
            disabled={busy || cancelling}
            onClick={() => {
              void store.cancel(active.id)
            }}
          >
            <Square aria-hidden />
            {cancelling ? '停止待确认' : '停止运行'}
          </DropdownMenuItem>
        )}

        {!hasPlan(automation.schedule) ? null : (
          <DropdownMenuItem
            disabled={busy}
            onClick={() => {
              void store.setEnabled(automation.id, !automation.enabled)
            }}
          >
            {automation.enabled ? <Pause aria-hidden /> : <CirclePlay aria-hidden />}
            {automation.enabled ? '暂停' : '启用'}
          </DropdownMenuItem>
        )}

        <DropdownMenuItem
          disabled={busy}
          onClick={() => {
            onOpen(automation.id)
          }}
        >
          <Pencil aria-hidden />
          编辑定时任务
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        <DropdownMenuItem
          danger
          disabled={busy || active !== null}
          onClick={() => {
            onDelete(automation)
          }}
        >
          <Trash aria-hidden />
          删除
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function CreateButton({ onCreateBlank }: { readonly onCreateBlank: () => void }) {
  return (
    <button
      className="inline-flex items-center rounded-lg bg-foreground px-4 py-2 text-xs font-medium text-background transition-opacity hover:opacity-90"
      onClick={onCreateBlank}
      type="button"
    >
      创建定时任务
    </button>
  )
}

/* 这一行目前只是界面：仓库里没有任何电源管理能力，开关切了不改变任何行为。接上真实的防休眠命令之前，别把它当成能用的开关。 */
function KeepAwakeRow() {
  const [keepAwake, setKeepAwake] = useState(false)
  return (
    <div className="mt-5 flex items-center gap-2 rounded-2xl border px-5 py-3.5">
      <Info aria-hidden className=" text-muted-foreground" />
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
