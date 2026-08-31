import {
  type CommonScheduleKind,
  DEFAULT_SCHEDULE,
  DEFAULT_SCHEDULE_TIME,
  describeMoment,
  describeSchedule,
  nextRunAfter,
  type ScheduleKind,
  type ScheduleProblem,
  scheduleFor,
  scheduleKindOf,
  scheduleProblem,
  scheduleTimeOf,
} from '@poietica/automation'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@poietica/design-system'
import { ChevronDown, Plus, X } from 'lucide-react'
import { useState } from 'react'

const PROBLEMS: Record<ScheduleProblem, string> = {
  neverRuns: '这段表达式永远不会到期。',
  tooFrequent: '最小调度粒度是一分钟。',
  unreadable: '读不懂这段 crontab 表达式。',
}

const LABELS: Record<ScheduleKind, string> = {
  hourly: '每小时',
  daily: '每天',
  weekdays: '每工作日',
  weekly: '每周',
  monthly: '每月',
  custom: '自定义',
}

const OPTIONS: readonly { readonly value: ScheduleKind; readonly label: string }[] = [
  { value: 'hourly', label: '每小时' },
  { value: 'daily', label: '每天' },
  { value: 'weekdays', label: '每工作日' },
  { value: 'weekly', label: '每周' },
  { value: 'monthly', label: '每月' },
  { value: 'custom', label: '自定义' },
]

const offsetFormatter = new Intl.DateTimeFormat('en', { timeZoneName: 'shortOffset' })

function localOffsetLabel(): string {
  return (
    offsetFormatter.formatToParts(new Date()).find((part) => part.type === 'timeZoneName')?.value ??
    Intl.DateTimeFormat().resolvedOptions().timeZone
  )
}

function ScheduleMenu({
  empty,
  onPick,
  selected,
}: {
  readonly empty: boolean
  readonly onPick: (kind: ScheduleKind) => void
  readonly selected: ScheduleKind | null
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={
          empty
            ? 'flex h-11 w-full items-center gap-2 rounded-xl border border-divider bg-background px-4 text-sm text-muted-foreground hover:bg-sidebar-accent/30'
            : 'inline-flex h-8 items-center gap-1 rounded-lg bg-sidebar-accent/60 px-3 text-sm text-foreground hover:bg-sidebar-accent'
        }
        type="button"
      >
        {empty ? <Plus aria-hidden className="size-4" /> : null}
        <span>{empty ? '添加计划' : LABELS[selected ?? 'daily']}</span>
        {empty ? null : <ChevronDown aria-hidden className="size-3.5 opacity-60" />}
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-48">
        {OPTIONS.map((option) => (
          <DropdownMenuItem
            key={option.value}
            onClick={() => {
              onPick(option.value)
            }}
          >
            {option.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export interface AutomationScheduleFieldProps {
  readonly onChange: (schedule: string | null) => void
  readonly schedule: string | null
}

export function AutomationScheduleField({ onChange, schedule }: AutomationScheduleFieldProps) {
  const [forceCustom, setForceCustom] = useState(false)
  const detected = scheduleKindOf(schedule)
  const kind = forceCustom ? 'custom' : detected
  const time = scheduleTimeOf(schedule) ?? DEFAULT_SCHEDULE_TIME

  function pick(next: ScheduleKind): void {
    if (next === 'custom') {
      setForceCustom(true)
      onChange(schedule ?? DEFAULT_SCHEDULE)
      return
    }

    setForceCustom(false)
    onChange(scheduleFor(next, time))
  }

  if (schedule === null) {
    return <ScheduleMenu empty onPick={pick} selected={null} />
  }

  const activeKind: ScheduleKind = kind ?? 'custom'
  const problem = scheduleProblem(schedule)
  const next = problem === null ? nextRunAfter(schedule, Date.now()) : null
  const feedbackId = 'automation-schedule-feedback'

  return (
    <div>
      <div className="flex min-h-11 flex-wrap items-center gap-2 rounded-xl border border-divider bg-background px-3 py-1.5">
        <ScheduleMenu empty={false} onPick={pick} selected={activeKind} />

        {activeKind === 'custom' ? (
          <input
            aria-describedby={feedbackId}
            aria-invalid={problem !== null}
            aria-label="crontab 表达式"
            autoComplete="off"
            className="h-8 min-w-44 flex-1 rounded-lg bg-sidebar-accent/60 px-3 font-mono text-xs tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onChange={(event) => {
              onChange(event.target.value)
            }}
            spellCheck={false}
            value={schedule}
          />
        ) : null}

        {activeKind !== 'custom' && activeKind !== 'hourly' ? (
          <>
            <span className="text-xs text-muted-foreground">于</span>
            <input
              aria-describedby={feedbackId}
              aria-label="运行时间"
              className="h-8 w-[104px] rounded-lg bg-sidebar-accent/60 px-2 text-sm tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onChange={(event) => {
                if (event.currentTarget.value !== '') {
                  onChange(scheduleFor(activeKind as CommonScheduleKind, event.currentTarget.value))
                }
              }}
              step={60}
              type="time"
              value={time}
            />
          </>
        ) : null}

        <span className="text-xs text-muted-foreground">{localOffsetLabel()}</span>
        <span className="text-xs text-muted-foreground">
          {activeKind === 'custom' ? '自定义' : describeSchedule(schedule)}
        </span>

        <button
          aria-label="移除计划"
          className="ml-auto grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
          onClick={() => {
            setForceCustom(false)
            onChange(null)
          }}
          title="移除计划"
          type="button"
        >
          <X aria-hidden className="size-3.5" />
        </button>
      </div>

      <p
        className={`mt-2 text-xs ${problem === null ? 'text-muted-foreground' : 'text-destructive'}`}
        id={feedbackId}
        role={problem === null ? undefined : 'alert'}
      >
        {problem !== null
          ? PROBLEMS[problem]
          : next === null
            ? '没有下一次运行。'
            : `下一次 ${describeMoment(next)}`}
      </p>
    </div>
  )
}
