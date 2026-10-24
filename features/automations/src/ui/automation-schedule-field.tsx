import './automation-schedule-field.css'

import {
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Select,
} from '@poietica/design-system'
import { Check, ChevronDown, Plus, X } from 'lucide-react'
import { useCallback, useState } from 'react'
import type { ScheduleProblem } from '../contract'
import {
  DEFAULT_SCHEDULE,
  DEFAULT_SCHEDULE_TIME,
  describeSchedule,
  formatGmtOffset,
  pad2,
  type ScheduleKind,
  scheduleDayOfMonthOf,
  scheduleFor,
  scheduleKindOf,
  scheduleMinuteOf,
  scheduleTimeOf,
  scheduleWeekdaysOf,
  WEEKDAY_LABELS,
  WEEKDAY_ORDER,
  type Weekday,
} from './automation'

/* 调度栏。交互对齐 zcode：频率、时间、GMT 偏移与一句可读摘要收在同一条 36px 的输入框里；
 * 时间与星期都是「胶囊触发器 + 弹层」，时间弹层选完不关闭，方便继续微调分。 */
const PROBLEMS: Record<ScheduleProblem, string> = {
  never_runs: '这段日程没有未来的运行时间。',
  too_frequent: '最小调度粒度是一分钟。',
  unreadable: '无法识别这段 crontab 表达式。',
  time_zone: '任务记着的时区无效。',
  in_past: '这个时间已经过去了。',
  conflict: '周期计划与一次性时间只能二选一。',
}

type FieldKind = ScheduleKind | 'once'

const LABELS: Record<FieldKind, string> = {
  once: '一次',
  hourly: '每小时',
  daily: '每天',
  weekdays: '每工作日',
  weekly: '每周',
  monthly: '每月',
  custom: '自定义',
}

const OPTIONS: readonly FieldKind[] = ['once', 'hourly', 'daily', 'weekdays', 'weekly', 'monthly', 'custom']

export interface ScheduleValue {
  readonly cron: string | null
  readonly at: number | null
}

export function localInputOf(at: number): string {
  const d = new Date(at)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

export function atOfLocalInput(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null
  const at = new Date(value).getTime()
  return Number.isFinite(at) ? at : null
}

export function defaultOnceAt(now = Date.now()): number {
  const d = new Date(now)
  d.setDate(d.getDate() + 1)
  const [hour = 9, minute = 0] = DEFAULT_SCHEDULE_TIME.split(':').map(Number)
  d.setHours(hour, minute, 0, 0)
  return d.getTime()
}

const MONTH_DAY_OPTIONS = Array.from({ length: 31 }, (_, index) => ({
  label: `${index + 1} 号`,
  value: String(index + 1),
}))

function ScheduleMenu({
  empty,
  onPick,
  selected,
}: {
  readonly empty: boolean
  readonly onPick: (kind: FieldKind) => void
  readonly selected: FieldKind | null
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={
          empty
            ? 'flex h-11 w-full items-center gap-2 rounded-xl border  bg-popover px-4 text-sm text-muted-foreground hover:bg-[var(--ui-popup-highlight)]'
            : 'inline-flex h-7 items-center gap-1 rounded-full bg-sidebar-accent/60 pl-3 pr-2 text-xs text-foreground hover:bg-sidebar-accent data-[popup-open]:bg-sidebar-accent'
        }
        type="button"
      >
        {empty ? <Plus aria-hidden /> : null}
        <span>{empty ? '添加计划' : LABELS[selected ?? 'daily']}</span>
        {empty ? null : <ChevronDown aria-hidden className=" opacity-60" />}
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

const HOURS: readonly string[] = Array.from({ length: 24 }, (_, hour) => pad2(hour))

const MINUTES: readonly string[] = Array.from({ length: 60 }, (_, minute) => pad2(minute))

function TimeColumn({
  label,
  onPick,
  options,
  selected,
}: {
  readonly label: string
  readonly onPick: (value: string) => void
  readonly options: readonly string[]
  readonly selected: string
}) {
  /** 分钟那列有 60 项，打开不该从 00 数起；推迟一帧让浮层自己的焦点先落位。 */
  const reveal = useCallback((node: HTMLElement | null) => {
    requestAnimationFrame(() => {
      if (node?.isConnected === true) {
        node.scrollIntoView({ block: 'nearest' })
      }
    })
  }, [])

  return (
    <fieldset
      aria-label={label}
      className="automation-schedule-field__column max-h-52 w-12 overflow-y-auto overscroll-contain"
    >
      {options.map((option) => (
        <DropdownMenuItem
          className={cn(
            'min-h-7 justify-center rounded-lg px-0 text-xs tabular-nums',
            option === selected && 'bg-[var(--ui-popup-highlight)] font-medium',
          )}
          closeOnClick={false}
          key={option}
          onClick={() => {
            onPick(option)
          }}
          ref={option === selected ? reveal : undefined}
        >
          {option}
        </DropdownMenuItem>
      ))}
    </fieldset>
  )
}

/** zcode 的时间胶囊：`09:00 ˅` 收起时只报时刻，展开是小时 / 分钟两列，选完继续留在面板里微调。 */
function TimePicker({ onChange, time }: { readonly onChange: (time: string) => void; readonly time: string }) {
  const [hours = '00', minutes = '00'] = time.split(':')

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="运行时间"
        className="inline-flex h-7 items-center gap-0.5 rounded-full bg-sidebar-accent/60 py-px pl-2.5 pr-1.5 text-xs tabular-nums text-foreground hover:bg-sidebar-accent data-[popup-open]:bg-sidebar-accent"
        type="button"
      >
        <span>{time}</span>
        <ChevronDown aria-hidden className=" text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-auto min-w-0 p-1">
        <div className="flex gap-1">
          <TimeColumn
            label="小时"
            onPick={(hour) => {
              onChange(`${hour}:${minutes}`)
            }}
            options={HOURS}
            selected={hours}
          />
          <span aria-hidden className="w-px shrink-0 bg-divider" />
          <TimeColumn
            label="分钟"
            onPick={(minute) => {
              onChange(`${hours}:${minute}`)
            }}
            options={MINUTES}
            selected={minutes}
          />
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** 星期多选。与 zcode 一样是一颗语句式胶囊，至少保留一天。 */
function WeekdayPicker({
  onChange,
  weekdays,
}: {
  readonly onChange: (weekdays: readonly Weekday[]) => void
  readonly weekdays: readonly Weekday[]
}) {
  const ordered = WEEKDAY_ORDER.filter((day) => weekdays.includes(day))
  const label = ordered.length === 0 ? '周一' : ordered.map((day) => WEEKDAY_LABELS[day]).join('、')
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="星期"
        className="inline-flex h-7 max-w-44 items-center gap-0.5 rounded-full bg-sidebar-accent/60 py-px pl-2.5 pr-1.5 text-xs text-foreground hover:bg-sidebar-accent data-[popup-open]:bg-sidebar-accent"
        type="button"
      >
        <span className="truncate">{label}</span>
        <ChevronDown aria-hidden className=" text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-36">
        {WEEKDAY_ORDER.map((day) => {
          const active = weekdays.includes(day)
          return (
            <DropdownMenuItem
              closeOnClick={false}
              key={day}
              onClick={() => {
                if (active && weekdays.length === 1) return
                const next = active ? weekdays.filter((value) => value !== day) : [...weekdays, day]
                onChange(WEEKDAY_ORDER.filter((value) => next.includes(value)))
              }}
            >
              <span className="min-w-0 flex-1">{WEEKDAY_LABELS[day]}</span>
              {active ? <Check aria-hidden /> : null}
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export interface AutomationScheduleFieldProps {
  readonly schedule: ScheduleValue
  readonly preview: { readonly times: readonly number[]; readonly problem: ScheduleProblem | null } | null
  readonly error: string | null
  readonly onChange: (schedule: ScheduleValue) => void
}

function OnceInput({
  at,
  feedback,
  onChange,
}: {
  readonly at: number
  readonly feedback: string | null
  readonly onChange: (schedule: ScheduleValue) => void
}) {
  return (
    <input
      aria-describedby="automation-schedule-feedback"
      aria-invalid={feedback !== null}
      aria-label="运行时间"
      className="h-7 rounded-full bg-sidebar-accent/60 px-2.5 text-xs tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onChange={(event) => {
        const next = atOfLocalInput(event.currentTarget.value)
        if (next !== null) onChange({ cron: null, at: next })
      }}
      type="datetime-local"
      value={localInputOf(at)}
    />
  )
}

function HourlyMinutePicker({
  onChange,
  minute,
}: {
  readonly onChange: (minute: number) => void
  readonly minute: number
}) {
  const selected = pad2(minute)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="分钟"
        className="inline-flex h-7 items-center gap-0.5 rounded-full bg-sidebar-accent/60 py-px pl-2.5 pr-1.5 text-xs tabular-nums text-foreground hover:bg-sidebar-accent data-[popup-open]:bg-sidebar-accent"
        type="button"
      >
        <span>{selected} 分</span>
        <ChevronDown aria-hidden className=" text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-auto min-w-0 p-1">
        <TimeColumn
          label="分钟"
          onPick={(next) => {
            onChange(Number(next))
          }}
          options={MINUTES}
          selected={selected}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function MonthDayPicker({
  dayOfMonth,
  onChange,
}: {
  readonly dayOfMonth: number
  readonly onChange: (day: number) => void
}) {
  return (
    <Select
      className="h-7 rounded-full border-0 bg-sidebar-accent/60 pl-2.5 pr-1.5 text-xs hover:bg-sidebar-accent"
      data={MONTH_DAY_OPTIONS}
      onValueChange={(next) => {
        onChange(Number(next))
      }}
      type="日期"
      value={String(dayOfMonth)}
    />
  )
}

function ScheduleDetail({
  dayOfMonth,
  kind,
  onChange,
  time,
  weekdays,
}: {
  readonly dayOfMonth: number
  readonly kind: FieldKind
  readonly onChange: (schedule: ScheduleValue) => void
  readonly time: string
  readonly weekdays: readonly Weekday[]
}) {
  if (kind === 'weekly') {
    return (
      <WeekdayPicker
        onChange={(next) => {
          onChange({ cron: scheduleFor('weekly', time, next), at: null })
        }}
        weekdays={weekdays}
      />
    )
  }
  if (kind === 'monthly') {
    return (
      <MonthDayPicker
        dayOfMonth={dayOfMonth}
        onChange={(day) => {
          onChange({ cron: scheduleFor('monthly', time, weekdays, day), at: null })
        }}
      />
    )
  }
  return null
}

function ScheduleRow({
  feedback,
  kind,
  onClear,
  onChange,
  onPick,
  schedule,
  time,
  dayOfMonth,
  weekdays,
}: {
  readonly feedback: string | null
  readonly kind: FieldKind
  readonly onClear: () => void
  readonly onChange: (schedule: ScheduleValue) => void
  readonly onPick: (kind: FieldKind) => void
  readonly schedule: ScheduleValue
  readonly time: string
  readonly dayOfMonth: number
  readonly weekdays: readonly Weekday[]
}) {
  const cron = schedule.cron
  if (cron === null && schedule.at === null) {
    return <ScheduleMenu empty onPick={onPick} selected={null} />
  }
  const pickTime = (next: string): void => {
    if (kind === 'weekly') {
      onChange({ cron: scheduleFor('weekly', next, weekdays), at: null })
    } else if (kind === 'monthly') {
      onChange({ cron: scheduleFor('monthly', next, weekdays, dayOfMonth), at: null })
    } else if (kind === 'daily' || kind === 'weekdays' || kind === 'hourly') {
      onChange({ cron: scheduleFor(kind, next, weekdays, dayOfMonth), at: null })
    }
  }
  const repeating = schedule.at === null && kind !== 'custom' && kind !== 'once'
  return (
    <div className="flex min-h-9 flex-nowrap items-center gap-1 overflow-hidden rounded-xl border bg-popover py-1 pl-[7px] pr-2">
      <ScheduleMenu empty={false} onPick={onPick} selected={kind} />
      {schedule.at !== null ? <OnceInput at={schedule.at} feedback={feedback} onChange={onChange} /> : null}
      {schedule.at === null && kind === 'custom' ? (
        <input
          aria-describedby="automation-schedule-feedback"
          aria-invalid={feedback !== null}
          aria-label="crontab 表达式"
          autoComplete="off"
          className="h-7 min-w-44 flex-1 rounded-full bg-sidebar-accent/60 px-3 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onChange={(event) => onChange({ cron: event.currentTarget.value, at: null })}
          spellCheck={false}
          value={cron ?? ''}
        />
      ) : null}
      {repeating ? (
        <>
          <ScheduleDetail dayOfMonth={dayOfMonth} kind={kind} onChange={onChange} time={time} weekdays={weekdays} />
          <span className="px-0.5 text-xs text-muted-foreground">于</span>
          {kind === 'hourly' ? (
            <HourlyMinutePicker
              minute={scheduleMinuteOf(cron) ?? 0}
              onChange={(minute) => {
                onChange({ cron: scheduleFor('hourly', `${time.split(':')[0] ?? '00'}:${pad2(minute)}`), at: null })
              }}
            />
          ) : (
            <TimePicker onChange={pickTime} time={time} />
          )}
          {kind === 'hourly' ? null : (
            <span className="whitespace-nowrap text-xs text-muted-foreground">{formatGmtOffset()}</span>
          )}
          <span className="min-w-0 flex-1 truncate pl-1 text-xs text-muted-foreground">{describeSchedule(cron)}</span>
        </>
      ) : null}
      <button
        aria-label="移除计划"
        className="ml-auto rounded-md p-1.5 text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
        onClick={onClear}
        type="button"
      >
        <X aria-hidden />
      </button>
    </div>
  )
}
export function AutomationScheduleField({ schedule, preview, error, onChange }: AutomationScheduleFieldProps) {
  const [forceCustom, setForceCustom] = useState(false)
  const cron = schedule.cron
  const kind: FieldKind = schedule.at !== null ? 'once' : forceCustom ? 'custom' : (scheduleKindOf(cron) ?? 'custom')
  const time = scheduleTimeOf(cron) ?? DEFAULT_SCHEDULE_TIME
  const weekdays = scheduleWeekdaysOf(cron)
  const dayOfMonth = scheduleDayOfMonthOf(cron) ?? 1
  const problem = preview?.problem ?? null
  const feedback = error ?? (problem === null ? null : PROBLEMS[problem])
  function pick(next: FieldKind): void {
    setForceCustom(next === 'custom')
    if (next === 'once') {
      onChange({ cron: null, at: schedule.at ?? defaultOnceAt() })
    } else if (next === 'custom') {
      onChange({ cron: cron ?? DEFAULT_SCHEDULE, at: null })
    } else if (next === 'weekly') {
      onChange({ cron: scheduleFor('weekly', time, [1]), at: null })
    } else if (next === 'weekdays') {
      onChange({ cron: scheduleFor('weekdays', time), at: null })
    } else {
      onChange({ cron: scheduleFor(next, time), at: null })
    }
  }
  return (
    <div className="space-y-3">
      <ScheduleRow
        dayOfMonth={dayOfMonth}
        feedback={feedback}
        kind={kind}
        onChange={onChange}
        onClear={() => {
          setForceCustom(false)
          onChange({ cron: null, at: null })
        }}
        onPick={pick}
        schedule={schedule}
        time={time}
        weekdays={weekdays}
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
