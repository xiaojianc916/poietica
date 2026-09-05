import {
  type CommonScheduleKind,
  DEFAULT_SCHEDULE,
  DEFAULT_SCHEDULE_TIME,
  type ScheduleKind,
  type SchedulePreview,
  type ScheduleProblem,
  scheduleFor,
  scheduleKindOf,
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
  neverRuns: '这段日程没有未来的运行时间。',
  tooFrequent: '最小调度粒度是一分钟。',
  unreadable: '无法识别这段 crontab 表达式。',
  timeZone: '请输入有效的 IANA 时区，例如 Asia/Shanghai。',
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
  readonly schedule: string | null
  readonly timeZone: string
  readonly preview: SchedulePreview | null
  readonly error: string | null
  readonly onChange: (schedule: string | null) => void
  readonly onTimeZoneChange: (timeZone: string) => void
}

export function AutomationScheduleField({
  schedule,
  timeZone,
  preview,
  error,
  onChange,
  onTimeZoneChange,
}: AutomationScheduleFieldProps) {
  const [forceCustom, setForceCustom] = useState(false)
  const kind: ScheduleKind = forceCustom ? 'custom' : (scheduleKindOf(schedule) ?? 'custom')
  const time = scheduleTimeOf(schedule) ?? DEFAULT_SCHEDULE_TIME
  const problem = preview?.problem ?? null
  const feedback = error ?? (problem === null ? null : PROBLEMS[problem])
  const next = preview?.nextRunAt ?? null
  function pick(next: ScheduleKind): void {
    setForceCustom(next === 'custom')
    onChange(next === 'custom' ? (schedule ?? DEFAULT_SCHEDULE) : scheduleFor(next, time))
  }
  return (
    <div className="space-y-3">
      {schedule === null ? (
        <ScheduleMenu empty onPick={pick} selected={null} />
      ) : (
        <div className="flex min-h-11 flex-wrap items-center gap-2 rounded-xl border border-divider bg-background px-3 py-1.5">
          <ScheduleMenu empty={false} onPick={pick} selected={kind} />
          {kind === 'custom' ? (
            <input
              aria-describedby="automation-schedule-feedback"
              aria-invalid={feedback !== null}
              aria-label="crontab 表达式"
              autoComplete="off"
              className="h-8 min-w-44 flex-1 rounded-lg bg-sidebar-accent/60 px-3 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onChange={(event) => onChange(event.currentTarget.value)}
              spellCheck={false}
              value={schedule}
            />
          ) : kind === 'hourly' ? null : (
            <input
              aria-label="运行时间"
              className="h-8 rounded-lg bg-sidebar-accent/60 px-2 text-sm"
              onChange={(event) => {
                if (event.currentTarget.value !== '') {
                  onChange(scheduleFor(kind as CommonScheduleKind, event.currentTarget.value))
                }
              }}
              step={60}
              type="time"
              value={time}
            />
          )}
          <button
            aria-label="移除计划"
            className="ml-auto rounded-md p-1.5 hover:bg-sidebar-accent"
            onClick={() => {
              setForceCustom(false)
              onChange(null)
            }}
            type="button"
          >
            <X aria-hidden className="size-3.5" />
          </button>
        </div>
      )}
      <label
        className="flex items-center gap-3 text-xs text-muted-foreground"
        htmlFor="automation-time-zone"
      >
        IANA 时区
        <input
          aria-describedby="automation-schedule-feedback"
          aria-invalid={problem === 'timeZone'}
          autoComplete="off"
          className="h-9 flex-1 rounded-lg border border-divider bg-background px-3 text-foreground"
          id="automation-time-zone"
          onChange={(event) => onTimeZoneChange(event.currentTarget.value)}
          placeholder="Asia/Shanghai"
          spellCheck={false}
          value={timeZone}
        />
      </label>
      <p
        className={feedback === null ? 'text-xs text-muted-foreground' : 'text-xs text-destructive'}
        id="automation-schedule-feedback"
        role={feedback === null ? 'status' : 'alert'}
      >
        {feedback ??
          (preview === null
            ? '正在由原生调度器校验…'
            : schedule === null
              ? '仅手动运行'
              : next === null
                ? '没有下一次运行'
                : ['下一次：', new Date(next).toLocaleString('zh-CN'), '（本机时间）'].join(''))}
      </p>
    </div>
  )
}
