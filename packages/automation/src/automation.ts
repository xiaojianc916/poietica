import type {
  Automation,
  AutomationCreation,
  AutomationRun,
  AutomationRunOutcome,
} from '@poietica/contract/automation'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const SUMMARY_WINDOW = 7 * DAY

export function summarize(automations: readonly Automation[], now = Date.now()) {
  let succeeded = 0
  let failed = 0
  for (const automation of automations) {
    for (const run of automation.runs) {
      const age = now - Date.parse(run.settledAt ?? run.startedAt)
      if (!Number.isFinite(age) || age < 0 || age > SUMMARY_WINDOW) {
        continue
      }
      if (run.outcome === 'succeeded') {
        succeeded += 1
      } else if (run.outcome === 'failed') {
        failed += 1
      }
    }
  }
  return { total: automations.length, succeeded, failed }
}

export function isTerminal(outcome: AutomationRunOutcome): boolean {
  return outcome === 'succeeded' || outcome === 'failed' || outcome === 'cancelled'
}

export const RUN_LABELS: Readonly<Record<AutomationRunOutcome, string>> = {
  queued: '已排队',
  dispatching: '正在提交',
  running: '运行中',
  cancelling: '等待停止确认',
  uncertain: '结果待核对',
  succeeded: '成功',
  failed: '失败',
  cancelled: '已取消',
}

export function activeRun(automation: Automation): AutomationRun | null {
  return automation.runs.find((run) => !isTerminal(run.outcome)) ?? null
}

// Only product-authored presets are recognized here; cron evaluation belongs to native scheduling.
export type CommonScheduleKind = 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'monthly'
export type ScheduleKind = CommonScheduleKind | 'custom'

export const DEFAULT_SCHEDULE_TIME = '09:00'

interface CommonSchedule {
  readonly kind: CommonScheduleKind
  readonly time: string | null
}

const CLOCK_CRON = /^([0-5]?\d) ([01]?\d|2[0-3]) (\*|1) \* (\*|1-5|1)$/

function commonScheduleOf(schedule: string | null): CommonSchedule | null {
  if (schedule === '0 * * * *') {
    return { kind: 'hourly', time: null }
  }
  if (schedule === null) {
    return null
  }

  const match = CLOCK_CRON.exec(schedule)
  if (match === null) {
    return null
  }

  const [, minute, hour, dayOfMonth, dayOfWeek] = match
  if (minute === undefined || hour === undefined) {
    return null
  }
  const time = `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`

  if (dayOfMonth === '1' && dayOfWeek === '*') {
    return { kind: 'monthly', time }
  }
  if (dayOfMonth !== '*') {
    return null
  }
  if (dayOfWeek === '*') {
    return { kind: 'daily', time }
  }
  if (dayOfWeek === '1-5') {
    return { kind: 'weekdays', time }
  }
  if (dayOfWeek === '1') {
    return { kind: 'weekly', time }
  }
  return null
}

export function scheduleKindOf(schedule: string | null): ScheduleKind | null {
  return commonScheduleOf(schedule)?.kind ?? (schedule === null ? null : 'custom')
}

export function scheduleTimeOf(schedule: string | null): string | null {
  return commonScheduleOf(schedule)?.time ?? null
}

function timeParts(time: string): { readonly hour: number; readonly minute: number } {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time)
  if (match === null || match[1] === undefined || match[2] === undefined) {
    throw new Error(`无效时间：${time}`)
  }
  return { hour: Number(match[1]), minute: Number(match[2]) }
}

export function scheduleFor(
  kind: CommonScheduleKind,
  time: string = DEFAULT_SCHEDULE_TIME,
): string {
  if (kind === 'hourly') {
    return '0 * * * *'
  }

  const { hour, minute } = timeParts(time)
  if (kind === 'daily') {
    return [minute, hour, '*', '*', '*'].join(' ')
  }
  if (kind === 'weekdays') {
    return [minute, hour, '*', '*', '1-5'].join(' ')
  }
  if (kind === 'weekly') {
    return [minute, hour, '*', '*', '1'].join(' ')
  }
  return [minute, hour, '1', '*', '*'].join(' ')
}

export const DEFAULT_SCHEDULE = scheduleFor('daily')

const SCHEDULE_LABEL: Record<Exclude<CommonScheduleKind, 'hourly'>, string> = {
  daily: '每天',
  weekdays: '每工作日',
  weekly: '每周一',
  monthly: '每月 1 号',
}

export function describeSchedule(schedule: string | null): string {
  if (schedule === null) {
    return '手动'
  }
  const kind = scheduleKindOf(schedule)
  if (kind === null || kind === 'custom') {
    return schedule
  }
  if (kind === 'hourly') {
    return '每小时'
  }
  return `${SCHEDULE_LABEL[kind]} ${scheduleTimeOf(schedule) ?? DEFAULT_SCHEDULE_TIME}`
}

export type AutomationDraft = Omit<AutomationCreation, 'sessionConfig'> & {
  readonly sessionConfig: Readonly<Record<string, string>>
}

export const BLANK_DRAFT: AutomationDraft = {
  title: '',
  prompt: '',
  schedule: null,
  sessionConfig: {},
  workspaceRoot: '',
  timeZone: '',
}

export function sameSessionConfig(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean {
  return (
    Object.keys(left).length === Object.keys(right).length &&
    Object.keys(left).every((key) => left[key] === right[key])
  )
}

export function sessionConfigOf(automation: Automation): Readonly<Record<string, string>> {
  const selected: Record<string, string> = {}
  for (const [key, value] of Object.entries(automation.sessionConfig)) {
    if (value !== undefined) {
      selected[key] = value
    }
  }
  return selected
}

export function draftOf(automation: Automation): AutomationDraft {
  return {
    title: automation.title,
    prompt: automation.prompt,
    schedule: automation.schedule,
    sessionConfig: sessionConfigOf(automation),
    workspaceRoot: automation.workspaceRoot ?? '',
    timeZone: automation.timeZone,
  }
}

const RELATIVE = new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' })
const UNITS = [
  { unit: 'day', span: DAY },
  { unit: 'hour', span: HOUR },
  { unit: 'minute', span: MINUTE },
] as const

export function describeMoment(at: string, now = Date.now()): string {
  const delta = Date.parse(at) - now
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

export function latestRun(automation: Automation): AutomationRun | null {
  return automation.runs[0] ?? null
}
