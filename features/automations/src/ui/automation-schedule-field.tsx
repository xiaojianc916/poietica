import './automation-schedule-field.css'

import {
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Select,
  type SelectOption,
} from '@poietica/design-system'
import { ChevronDown, Clock, Plus, X } from 'lucide-react'
import { type ReactNode, useCallback, useState } from 'react'
import type { ScheduleProblem } from '../contract'
import {
  DEFAULT_SCHEDULE,
  DEFAULT_SCHEDULE_TIME,
  type ScheduleKind,
  scheduleFor,
  scheduleKindOf,
  scheduleTimeOf,
  scheduleWeekdayOf,
  WEEKDAY_LABELS,
  type Weekday,
} from './automation'

/*
 * 照 legacy `packages/automation/src/ui/automation-schedule-field.tsx` 逐字搬迁。
 * 三处随新契约变：ScheduleProblem 的键换成契约里的 snake_case（unreadable /
 * never_runs / too_frequent / time_zone，审查 R-14 再加 in_past / conflict），文案仍是 legacy 那四句；
 * preview 的形状由 {nextRunAt, problem} 换成 {times, problem}（05 页 §11.9），
 * 「下一次」取 times[0]；时区不再由界面给（任务一律落系统时区）。
 */

const PROBLEMS: Record<ScheduleProblem, string> = {
  never_runs: '这段日程没有未来的运行时间。',
  too_frequent: '最小调度粒度是一分钟。',
  unreadable: '无法识别这段 crontab 表达式。',
  /* 时区不再由界面给：任务一律落系统时区。这一条只为契约里的枚举键有着落。 */
  time_zone: '任务记着的时区无效。',
  in_past: '这个时间已经过去了。',
  conflict: '周期计划与一次性时间只能二选一。',
}

/* 「一次」不是 cron 的形状（审查 R-16）：它读 Schedule.at，所以只在这一格里与 cron 的几种并列。 */
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

/** 计划这一格的值：周期（cron）与一次性（at，毫秒）至多一个非 null；都为 null 是「只手动」。 */
export interface ScheduleValue {
  readonly cron: string | null
  readonly at: number | null
}

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** 毫秒 → `<input type="datetime-local">` 的值（本机时间）。 */
export function localInputOf(at: number): string {
  const d = new Date(at)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** `<input type="datetime-local">` 的值 → 毫秒（本机时间）；读不懂返回 null。 */
export function atOfLocalInput(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null
  const at = new Date(value).getTime()
  return Number.isFinite(at) ? at : null
}

/** 选「一次」时的起始值：明天的默认时刻（09:00，本机时间）。 */
export function defaultOnceAt(now = Date.now()): number {
  const d = new Date(now)
  d.setDate(d.getDate() + 1)
  const [hour = 9, minute = 0] = DEFAULT_SCHEDULE_TIME.split(':').map(Number)
  d.setHours(hour, minute, 0, 0)
  return d.getTime()
}

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
  readonly onPick: (kind: FieldKind) => void
  readonly selected: FieldKind | null
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

/*
 * 两列数字，点一下就是那个值。
 *
 * 不用原生 <input type="time">：点文字是编辑数字段，点时钟图标才是挑，同一个控件
 * 两副面孔；而这一行里其余两处（计划、星期）都是点选。两列各排各的，改小时不必
 * 先跨过分钟那一栏。
 */
const HOURS: readonly string[] = Array.from({ length: 24 }, (_, hour) => String(hour).padStart(2, '0'))

const MINUTES: readonly string[] = Array.from({ length: 60 }, (_, minute) => String(minute).padStart(2, '0'))

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
  /*
   * 选中项一挂上就滚进视野：分钟那列有 60 项，打开面板不该从 00 数起。
   *
   * 推迟一帧是因为浮层打开时自己还要聚焦一次，抢在它前面滚会被它滚回去。
   */
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
      className="automation-schedule-field__column max-h-56 w-14 overflow-y-auto overscroll-contain"
    >
      {options.map((option) => (
        <DropdownMenuItem
          className={cn('justify-center', option === selected && 'bg-[var(--ui-popup-highlight)]')}
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

/*
 * 时间触发器：点开是两列，选完即关。
 *
 * 值仍是 `HH:MM`（scheduleTimeOf / scheduleFor 那一对的口径），面板只负责把它拆成
 * 两段再拼回去，不认 cron。
 */
function TimePicker({ onChange, time }: { readonly onChange: (time: string) => void; readonly time: string }) {
  const [hours = '00', minutes = '00'] = time.split(':')

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="运行时间"
        className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-sidebar-accent/60 px-2.5 text-sm text-foreground hover:bg-sidebar-accent"
        type="button"
      >
        <span>{time}</span>
        <Clock aria-hidden className="size-3.5 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-auto min-w-0">
        <div className="flex gap-1">
          <TimeColumn
            label="小时"
            onPick={(hour) => {
              onChange(`${hour}:${minutes}`)
            }}
            options={HOURS}
            selected={hours}
          />
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

export interface AutomationScheduleFieldProps {
  readonly schedule: ScheduleValue
  readonly preview: { readonly times: readonly number[]; readonly problem: ScheduleProblem | null } | null
  readonly error: string | null
  readonly onChange: (schedule: ScheduleValue) => void
}

/* 一次性的那一格：原生日期时间框（日期必须能挑，两列数字挑不了日子）。 */
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
      className="h-8 rounded-lg bg-sidebar-accent/60 px-3 text-sm tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onChange={(event) => {
        const next = atOfLocalInput(event.currentTarget.value)
        if (next !== null) onChange({ cron: null, at: next })
      }}
      type="datetime-local"
      value={localInputOf(at)}
    />
  )
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
  readonly kind: FieldKind
  readonly onClear: () => void
  readonly onChange: (schedule: ScheduleValue) => void
  readonly onPick: (kind: FieldKind) => void
  readonly schedule: ScheduleValue
  readonly time: string
  readonly weekday: Weekday
}) {
  const cron = schedule.cron
  if (cron === null && schedule.at === null) {
    return <ScheduleMenu empty onPick={onPick} selected={null} />
  }
  let detail: ReactNode = null
  if (schedule.at !== null) {
    detail = <OnceInput at={schedule.at} feedback={feedback} onChange={onChange} />
  } else if (kind === 'custom') {
    detail = (
      <input
        aria-describedby="automation-schedule-feedback"
        aria-invalid={feedback !== null}
        aria-label="crontab 表达式"
        autoComplete="off"
        className="h-8 min-w-44 flex-1 rounded-lg bg-sidebar-accent/60 px-3 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onChange={(event) => onChange({ cron: event.currentTarget.value, at: null })}
        spellCheck={false}
        value={cron ?? ''}
      />
    )
  } else if (kind === 'weekly') {
    detail = (
      <Select
        className="h-8"
        data={WEEKDAYS}
        onValueChange={(next) => {
          onChange({ cron: scheduleFor('weekly', time, Number(next) as Weekday), at: null })
        }}
        type="星期"
        value={String(weekday)}
      />
    )
  } else if (kind !== 'hourly' && kind !== 'once') {
    detail = (
      <TimePicker
        onChange={(next) => {
          onChange({ cron: scheduleFor(kind, next, weekday), at: null })
        }}
        time={time}
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

export function AutomationScheduleField({ schedule, preview, error, onChange }: AutomationScheduleFieldProps) {
  const [forceCustom, setForceCustom] = useState(false)
  const cron = schedule.cron
  const kind: FieldKind = schedule.at !== null ? 'once' : forceCustom ? 'custom' : (scheduleKindOf(cron) ?? 'custom')
  const time = scheduleTimeOf(cron) ?? DEFAULT_SCHEDULE_TIME
  const weekday = scheduleWeekdayOf(cron) ?? 1
  const problem = preview?.problem ?? null
  const feedback = error ?? (problem === null ? null : PROBLEMS[problem])
  function pick(next: FieldKind): void {
    setForceCustom(next === 'custom')
    if (next === 'once') {
      onChange({ cron: null, at: schedule.at ?? defaultOnceAt() })
    } else if (next === 'custom') {
      onChange({ cron: cron ?? DEFAULT_SCHEDULE, at: null })
    } else {
      onChange({ cron: scheduleFor(next, time, weekday), at: null })
    }
  }
  return (
    <div className="space-y-3">
      <ScheduleRow
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
