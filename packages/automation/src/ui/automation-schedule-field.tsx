import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Select,
  type SelectOption,
} from '@poietica/design-system'
import { ChevronDown, Plus, X } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import {
  DEFAULT_SCHEDULE,
  DEFAULT_SCHEDULE_TIME,
  type ScheduleKind,
  type SchedulePreview,
  type ScheduleProblem,
  scheduleFor,
  scheduleKindOf,
  scheduleTimeOf,
  scheduleWeekdayOf,
  WEEKDAY_LABELS,
  type Weekday,
} from '../index'

const PROBLEMS: Record<ScheduleProblem, string> = {
  neverRuns: '这段日程没有未来的运行时间。',
  tooFrequent: '最小调度粒度是一分钟。',
  unreadable: '无法识别这段 crontab 表达式。',
  /* 时区不再由界面给：任务一律落系统时区。这一条只为契约里的枚举键有着落。 */
  timeZone: '任务记着的时区无效。',
}

const LABELS: Record<ScheduleKind, string> = {
  hourly: '每小时',
  daily: '每天',
  weekdays: '每工作日',
  weekly: '每周',
  monthly: '每月',
  custom: '自定义',
}

const OPTIONS: readonly ScheduleKind[] = [
  'hourly',
  'daily',
  'weekdays',
  'weekly',
  'monthly',
  'custom',
]

/* 「每周」必须连着说是周几，否则那颗下拉名不副实：它底下只能是周一。 */
const WEEKDAYS: readonly SelectOption[] = ([0, 1, 2, 3, 4, 5, 6] as const).map((day) => ({
  label: WEEKDAY_LABELS[day],
  value: String(day),
}))

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
            ? 'flex h-11 w-full items-center gap-2 rounded-xl border border-divider bg-popover px-4 text-sm text-muted-foreground hover:bg-[var(--ui-popup-highlight)]'
            : 'inline-flex h-8 items-center gap-1 rounded-lg bg-sidebar-accent/60 px-3 text-sm text-foreground hover:bg-sidebar-accent'
        }
        type="button"
      >
        {empty ? <Plus aria-hidden className="size-4" /> : null}
        <span>{empty ? '添加计划' : LABELS[selected ?? 'daily']}</span>
        {empty ? null : <ChevronDown aria-hidden className="size-3.5 opacity-60" />}
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-48">
        {OPTIONS.map((kind) => (
          <DropdownMenuItem
            key={kind}
            onClick={() => {
              onPick(kind)
            }}
          >
            {LABELS[kind]}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export interface AutomationScheduleFieldProps {
  readonly schedule: string | null
  readonly preview: SchedulePreview | null
  readonly error: string | null
  readonly onChange: (schedule: string | null) => void
}

/*
 * 计划那一行：没选过是一颗「添加计划」，选过之后是 [计划][星期][时间] 与移除键。
 * 拆出来只为把这一层的条件收进一个名字里，它读的全是调用点算好的值。
 */
function ScheduleRow({
  feedback,
  kind,
  onClear,
  onChange,
  onPick,
  schedule,
  time,
  weekday,
}: {
  readonly feedback: string | null
  readonly kind: ScheduleKind
  readonly onClear: () => void
  readonly onChange: (schedule: string | null) => void
  readonly onPick: (kind: ScheduleKind) => void
  readonly schedule: string | null
  readonly time: string
  readonly weekday: Weekday
}) {
  if (schedule === null) {
    return <ScheduleMenu empty onPick={onPick} selected={null} />
  }
  let detail: ReactNode = null
  if (kind === 'custom') {
    detail = (
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
    )
  } else if (kind === 'weekly') {
    detail = (
      <Select
        className="h-8"
        data={WEEKDAYS}
        onValueChange={(next) => {
          onChange(scheduleFor('weekly', time, Number(next) as Weekday))
        }}
        type="星期"
        value={String(weekday)}
      />
    )
  } else if (kind !== 'hourly') {
    detail = (
      <input
        aria-label="运行时间"
        className="h-8 rounded-lg bg-sidebar-accent/60 px-2 text-sm"
        onChange={(event) => {
          if (event.currentTarget.value !== '') {
            onChange(scheduleFor(kind, event.currentTarget.value, weekday))
          }
        }}
        step={60}
        type="time"
        value={time}
      />
    )
  }
  return (
    <div className="flex min-h-11 flex-wrap items-center gap-2 rounded-xl border border-divider bg-popover px-3 py-1.5">
      <ScheduleMenu empty={false} onPick={onPick} selected={kind} />
      {detail}
      <button
        aria-label="移除计划"
        className="ml-auto rounded-md p-1.5 hover:bg-sidebar-accent"
        onClick={onClear}
        type="button"
      >
        <X aria-hidden className="size-3.5" />
      </button>
    </div>
  )
}

export function AutomationScheduleField({
  schedule,
  preview,
  error,
  onChange,
}: AutomationScheduleFieldProps) {
  const [forceCustom, setForceCustom] = useState(false)
  const kind: ScheduleKind = forceCustom ? 'custom' : (scheduleKindOf(schedule) ?? 'custom')
  const time = scheduleTimeOf(schedule) ?? DEFAULT_SCHEDULE_TIME
  const weekday = scheduleWeekdayOf(schedule) ?? 1
  const problem = preview?.problem ?? null
  const feedback = error ?? (problem === null ? null : PROBLEMS[problem])
  function pick(next: ScheduleKind): void {
    setForceCustom(next === 'custom')
    onChange(next === 'custom' ? (schedule ?? DEFAULT_SCHEDULE) : scheduleFor(next, time, weekday))
  }
  return (
    <div className="space-y-3">
      <ScheduleRow
        feedback={feedback}
        kind={kind}
        onChange={onChange}
        onClear={() => {
          setForceCustom(false)
          onChange(null)
        }}
        onPick={pick}
        schedule={schedule}
        time={time}
        weekday={weekday}
      />
      {/* 「下一次」在「调度」标题右边（编辑器的 Field aside），这里只报校验失败。 */}
      {feedback === null ? null : (
        <p className="text-xs text-destructive" id="automation-schedule-feedback" role="alert">
          {feedback}
        </p>
      )}
    </div>
  )
}
