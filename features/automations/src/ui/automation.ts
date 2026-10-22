import { invariant } from '@poietica/foundation'
import type { Automation, AutomationDraft, AutomationRun, RunOutcome, RunTrigger, Schedule } from '../contract'

/* 照 legacy 逐字搬迁的纯逻辑。差别只有数据形状两处：时间戳由 ISO 字符串换成毫秒数；会话配置换成 AutomationDraft 的三格。 */

export const pad2 = (n: number): string => String(n).padStart(2, '0')

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export function isTerminal(outcome: RunOutcome): boolean {
  return outcome === 'succeeded' || outcome === 'failed' || outcome === 'cancelled' || outcome === 'skipped'
}

export const RUN_LABELS: Readonly<Record<RunOutcome, string>> = {
  running: '运行中',
  awaiting: '等待回答',
  succeeded: '成功',
  failed: '失败',
  cancelled: '已取消',
  skipped: '已跳过',
}

export function activeRun(runs: readonly AutomationRun[]): AutomationRun | null {
  return runs.find((run) => !isTerminal(run.outcome)) ?? null
}

export type CommonScheduleKind = 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'monthly'
export type ScheduleKind = CommonScheduleKind | 'custom'

export const DEFAULT_SCHEDULE_TIME = '09:00'

export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6

export const WEEKDAY_LABELS: Readonly<Record<Weekday, string>> = {
  0: '周日',
  1: '周一',
  2: '周二',
  3: '周三',
  4: '周四',
  5: '周五',
  6: '周六',
}

/** 界面上的星期顺序：周一到周日。cron 的数字顺序从周日起，展示不能跟着它走。 */
export const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const

interface CommonSchedule {
  readonly kind: CommonScheduleKind
  readonly time: string | null
  readonly minute: number | null
  readonly weekday: Weekday | null
  readonly weekdays: readonly Weekday[]
  readonly dayOfMonth: number | null
}

const HOURLY_CRON = /^([0-5]?\d) \* \* \* \*$/
const CLOCK_CRON = /^([0-5]?\d) ([01]?\d|2[0-3]) (\*|[1-9]|[12]\d|3[01]) \* (\*|1-5|[0-7](?:,[0-7])*)$/

function weekdayListOf(field: string): readonly Weekday[] {
  return [...new Set(field.split(',').map((day) => (Number(day) % 7) as Weekday))]
}

function commonScheduleOf(schedule: string | null): CommonSchedule | null {
  if (schedule === null) {
    return null
  }
  const hourly = HOURLY_CRON.exec(schedule)
  if (hourly?.[1] !== undefined) {
    return {
      kind: 'hourly',
      time: null,
      minute: Number(hourly[1]),
      weekday: null,
      weekdays: [],
      dayOfMonth: null,
    }
  }

  const match = CLOCK_CRON.exec(schedule)
  if (match === null) {
    return null
  }

  const [, minute, hour, dayOfMonth, dayOfWeek] = match
  if (minute === undefined || hour === undefined || dayOfMonth === undefined || dayOfWeek === undefined) {
    return null
  }
  const time = `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`

  if (dayOfMonth !== '*') {
    if (dayOfWeek !== '*') {
      return null
    }
    return {
      kind: 'monthly',
      time,
      minute: Number(minute),
      weekday: null,
      weekdays: [],
      dayOfMonth: Number(dayOfMonth),
    }
  }
  if (dayOfWeek === '*') {
    return { kind: 'daily', time, minute: Number(minute), weekday: null, weekdays: [], dayOfMonth: null }
  }
  if (dayOfWeek === '1-5') {
    return {
      kind: 'weekdays',
      time,
      minute: Number(minute),
      weekday: null,
      weekdays: [1, 2, 3, 4, 5],
      dayOfMonth: null,
    }
  }
  const weekdays = weekdayListOf(dayOfWeek)
  return {
    kind: 'weekly',
    time,
    minute: Number(minute),
    weekday: weekdays[0] ?? null,
    weekdays,
    dayOfMonth: null,
  }
}

export function scheduleKindOf(schedule: string | null): ScheduleKind | null {
  return commonScheduleOf(schedule)?.kind ?? (schedule === null ? null : 'custom')
}

export function scheduleTimeOf(schedule: string | null): string | null {
  return commonScheduleOf(schedule)?.time ?? null
}

export function scheduleMinuteOf(schedule: string | null): number | null {
  return commonScheduleOf(schedule)?.minute ?? null
}

export function scheduleWeekdayOf(schedule: string | null): Weekday | null {
  return commonScheduleOf(schedule)?.weekday ?? null
}

export function scheduleWeekdaysOf(schedule: string | null): readonly Weekday[] {
  return commonScheduleOf(schedule)?.weekdays ?? []
}

export function scheduleDayOfMonthOf(schedule: string | null): number | null {
  return commonScheduleOf(schedule)?.dayOfMonth ?? null
}

function timeParts(time: string): { readonly hour: number; readonly minute: number } {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time)
  if (match === null || match[1] === undefined || match[2] === undefined) {
    invariant(false, `无效时间：${time}`)
  }
  return { hour: Number(match[1]), minute: Number(match[2]) }
}

export function scheduleFor(
  kind: CommonScheduleKind,
  time: string = DEFAULT_SCHEDULE_TIME,
  weekdays: readonly Weekday[] = [1],
  dayOfMonth = 1,
): string {
  if (kind === 'hourly') {
    return [timeParts(time).minute, '*', '*', '*', '*'].join(' ')
  }

  const { hour, minute } = timeParts(time)
  if (kind === 'daily') {
    return [minute, hour, '*', '*', '*'].join(' ')
  }
  if (kind === 'weekdays') {
    return [minute, hour, '*', '*', '1-5'].join(' ')
  }
  if (kind === 'weekly') {
    const days = weekdays.length === 0 ? '1' : [...new Set(weekdays)].sort((a, b) => a - b).join(',')
    return [minute, hour, '*', '*', days].join(' ')
  }
  return [minute, hour, String(dayOfMonth), '*', '*'].join(' ')
}

export const DEFAULT_SCHEDULE = scheduleFor('daily')

/** 本地时区偏移 → GMT 文案（zcode 的 formatGmtOffset 口径），半小时时区写成 GMT+5:30。 */
export function formatGmtOffset(offsetMinutes = -new Date().getTimezoneOffset()): string {
  if (offsetMinutes === 0) {
    return 'GMT'
  }
  const sign = offsetMinutes > 0 ? '+' : '-'
  const absolute = Math.abs(offsetMinutes)
  const hours = Math.floor(absolute / 60)
  const minutes = absolute % 60
  return `GMT${sign}${hours}${minutes > 0 ? `:${pad2(minutes)}` : ''}`
}

export function describeSchedule(schedule: string | null): string {
  if (schedule === null) {
    return '手动'
  }
  const common = commonScheduleOf(schedule)
  if (common === null) {
    return schedule
  }
  if (common.kind === 'hourly') {
    return `每小时的第 ${pad2(common.minute ?? 0)} 分`
  }
  const time = common.time ?? DEFAULT_SCHEDULE_TIME
  if (common.kind === 'weekly') {
    const days = WEEKDAY_ORDER.filter((day) => common.weekdays.includes(day))
      .map((day) => WEEKDAY_LABELS[day])
      .join('、')
    return `每周${days} ${time}`
  }
  if (common.kind === 'monthly') {
    return `每月 ${common.dayOfMonth ?? 1} 号 ${time}`
  }
  if (common.kind === 'weekdays') {
    return `每工作日 ${time}`
  }
  return `每天 ${time}`
}

export function clockOf(at: number): string {
  const d = new Date(at)
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

export function describePlan(schedule: Pick<Schedule, 'cron' | 'at'>): string {
  if (schedule.at !== null) {
    return `一次 · ${clockOf(schedule.at)}`
  }
  return describeSchedule(schedule.cron)
}

export function hasPlan(schedule: Pick<Schedule, 'cron' | 'at'>): boolean {
  return schedule.cron !== null || schedule.at !== null
}

export const TRIGGER_LABELS: Readonly<Record<RunTrigger, string | null>> = {
  schedule: null,
  manual: '手动',
  catch_up: '补跑',
}

export const BLANK_DRAFT: AutomationDraft = {
  title: '',
  prompt: '',
  schedule: { cron: null, at: null, timeZone: '' },
  workspaceId: '',
  posture: 'auto-edit',
  model: null,
  thinking: null,
  threadMode: 'new',
  threadId: null,
  notify: 'attention',
  catchUp: true,
}

export function draftOf(automation: Automation): AutomationDraft {
  return {
    title: automation.title,
    prompt: automation.prompt,
    schedule: automation.schedule,
    workspaceId: automation.workspaceId,
    posture: automation.posture,
    model: automation.model,
    thinking: automation.thinking,
    threadMode: automation.threadMode,
    threadId: automation.threadId,
    notify: automation.notify,
    catchUp: automation.catchUp,
  }
}

export function sameDraft(left: AutomationDraft, right: AutomationDraft): boolean {
  return (
    left.title === right.title &&
    left.prompt === right.prompt &&
    left.schedule.cron === right.schedule.cron &&
    left.schedule.at === right.schedule.at &&
    left.schedule.timeZone === right.schedule.timeZone &&
    left.workspaceId === right.workspaceId &&
    left.posture === right.posture &&
    (left.model?.provider ?? null) === (right.model?.provider ?? null) &&
    (left.model?.id ?? null) === (right.model?.id ?? null) &&
    left.thinking === right.thinking &&
    left.threadMode === right.threadMode &&
    left.threadId === right.threadId &&
    left.notify === right.notify &&
    left.catchUp === right.catchUp
  )
}

const RELATIVE = new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' })
const UNITS = [
  { unit: 'day', span: DAY },
  { unit: 'hour', span: HOUR },
  { unit: 'minute', span: MINUTE },
] as const

export function describeMoment(at: number, now = Date.now()): string {
  const delta = at - now
  if (!Number.isFinite(delta)) {
    return '时间不可用'
  }
  for (const { unit, span } of UNITS) {
    if (Math.abs(delta) >= span) {
      return RELATIVE.format(Math.trunc(delta / span), unit)
    }
  }
  return RELATIVE.format(0, 'minute')
}

export function latestRun(runs: readonly AutomationRun[]): AutomationRun | null {
  return runs[0] ?? null
}
