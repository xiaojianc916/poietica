import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  SearchableSelect,
  type SelectOption,
} from '@poietica/design-system'
import { ChevronDown, Plus, X } from 'lucide-react'
import { useMemo, useState } from 'react'
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
} from '../index'

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

const OPTIONS: readonly ScheduleKind[] = [
  'hourly',
  'daily',
  'weekdays',
  'weekly',
  'monthly',
  'custom',
]

/*
 * 时区候选表读运行时那份 IANA 名录（Intl.supportedValuesOf，本机 418 条），不写死
 * 一份常量表：名录跟着平台的 tzdata 走，写死的那份要替时区的增删负责。TS 的 lib
 * 还没声明这个方法，所以按可选方法取，缺了就当名录为空。
 */
const TIME_ZONES: readonly SelectOption[] = (() => {
  const runtime = Intl as typeof Intl & {
    supportedValuesOf?: (key: 'timeZone') => string[]
  }
  return (runtime.supportedValuesOf?.('timeZone') ?? []).map((zone) => ({
    label: zone,
    value: zone,
  }))
})()

/*
 * 候选表里必须有当前值：存着的可能是旧别名，或原名录里已经移除的时区；缺了它
 * 触发器只显示占位符，屏幕上就没有这个值的落点。缺的补进来并注明来历。
 */
function withCurrentZone(current: string): readonly SelectOption[] {
  if (current === '' || TIME_ZONES.some((zone) => zone.value === current)) {
    return TIME_ZONES
  }
  return [{ label: `${current}（平台未提供）`, value: current }, ...TIME_ZONES]
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
  readonly timeZone: string
  readonly preview: SchedulePreview | null
  readonly error: string | null
  readonly onChange: (schedule: string | null) => void
  readonly onTimeZoneChange: (timeZone: string) => void
}

function statusText(preview: SchedulePreview | null, schedule: string | null): string {
  if (preview === null) {
    return '正在由原生调度器校验…'
  }
  if (schedule === null) {
    return '仅手动运行'
  }
  const next = preview.nextRunAt ?? null
  if (next === null) {
    return '没有下一次运行'
  }
  return ['下一次：', new Date(next).toLocaleString('zh-CN'), '（本机时间）'].join('')
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
  const zones = useMemo(() => withCurrentZone(timeZone), [timeZone])
  const kind: ScheduleKind = forceCustom ? 'custom' : (scheduleKindOf(schedule) ?? 'custom')
  const time = scheduleTimeOf(schedule) ?? DEFAULT_SCHEDULE_TIME
  const problem = preview?.problem ?? null
  const feedback = error ?? (problem === null ? null : PROBLEMS[problem])
  function pick(next: ScheduleKind): void {
    setForceCustom(next === 'custom')
    onChange(next === 'custom' ? (schedule ?? DEFAULT_SCHEDULE) : scheduleFor(next, time))
  }
  return (
    <div className="space-y-3">
      {schedule === null ? (
        <ScheduleMenu empty onPick={pick} selected={null} />
      ) : (
        <div className="flex min-h-11 flex-wrap items-center gap-2 rounded-xl border border-divider bg-popover px-3 py-1.5">
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
      {/* 与「添加计划」同一张脸：同样的高、同样的圆角、同样的 --ui-popover 底。
          名录四百多条，所以用可搜索的那种选择器，而不是菜单。 */}
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <span>IANA 时区</span>
        <SearchableSelect
          className="h-11 w-80 rounded-xl px-4 text-sm"
          data={zones}
          id="automation-time-zone"
          onValueChange={onTimeZoneChange}
          type="IANA 时区"
          value={timeZone}
        />
      </div>
      <p
        className={feedback === null ? 'text-xs text-muted-foreground' : 'text-xs text-destructive'}
        id="automation-schedule-feedback"
        role={feedback === null ? 'status' : 'alert'}
      >
        {feedback ?? statusText(preview, schedule)}
      </p>
    </div>
  )
}
