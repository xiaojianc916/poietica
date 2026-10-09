import { invariant } from '@poietica/foundation'
import type { Automation, AutomationDraft, AutomationRun, RunOutcome } from '../contract'

/*
 * 照 legacy `packages/automation/src/automation.ts` 逐字搬迁的纯逻辑：日程的
 * 人话说法、常见形状与 cron 之间的往返、运行记录的派生。
 *
 * 与新架构的差别只有数据形状两处：时间戳由 ISO 字符串换成毫秒数（契约 07 页 §9B），
 * 会话配置（sessionConfig 那本字典）换成 AutomationDraft 的 posture / model / thinking
 * 三格 —— legacy 里那一本是不透明的键值对，新契约把它收成了引擎认识的三个字段。
 */

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const SUMMARY_WINDOW = 7 * DAY

export function summarize(
  automations: readonly Automation[],
  runsOf: (automationId: string) => readonly AutomationRun[],
  now = Date.now(),
): { total: number; succeeded: number; failed: number } {
  let succeeded = 0
  let failed = 0
  for (const automation of automations) {
    for (const run of runsOf(automation.id)) {
      const age = now - (run.settledAt ?? run.startedAt)
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

export function isTerminal(outcome: RunOutcome): boolean {
  return outcome === 'succeeded' || outcome === 'failed' || outcome === 'cancelled'
}

export const RUN_LABELS: Readonly<Record<RunOutcome, string>> = {
  running: '运行中',
  awaiting: '等待回答',
  succeeded: '成功',
  failed: '失败',
  cancelled: '已取消',
}

export function activeRun(runs: readonly AutomationRun[]): AutomationRun | null {
  return runs.find((run) => !isTerminal(run.outcome)) ?? null
}

// Only product-authored presets are recognized here; cron evaluation belongs to Core scheduling.
export type CommonScheduleKind = 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'monthly'
export type ScheduleKind = CommonScheduleKind | 'custom'

export const DEFAULT_SCHEDULE_TIME = '09:00'

/*
 * cron 的星期号收进 0-6 这一支：1 是周一。cron 自己允许 7 表示周日，识别时折进来，
 * 界面因此只有七个选项。
 */
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

interface CommonSchedule {
  readonly kind: CommonScheduleKind
  readonly time: string | null
  /* 只有 weekly 给出这一格，其余 kind 为 null。 */
  readonly weekday: Weekday | null
}

const CLOCK_CRON = /^([0-5]?\d) ([01]?\d|2[0-3]) (\*|1) \* (\*|1-5|[0-7])$/

function commonScheduleOf(schedule: string | null): CommonSchedule | null {
  if (schedule === '0 * * * *') {
    return { kind: 'hourly', time: null, weekday: null }
  }
  if (schedule === null) {
    return null
  }

  const match = CLOCK_CRON.exec(schedule)
  if (match === null) {
    return null
  }

  const [, minute, hour, dayOfMonth, dayOfWeek] = match
  if (minute === undefined || hour === undefined || dayOfWeek === undefined) {
    return null
  }
  const time = `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`

  if (dayOfMonth === '1' && dayOfWeek === '*') {
    return { kind: 'monthly', time, weekday: null }
  }
  if (dayOfMonth !== '*') {
    return null
  }
  if (dayOfWeek === '*') {
    return { kind: 'daily', time, weekday: null }
  }
  if (dayOfWeek === '1-5') {
    return { kind: 'weekdays', time, weekday: null }
  }
  return { kind: 'weekly', time, weekday: (Number(dayOfWeek) % 7) as Weekday }
}

export function scheduleKindOf(schedule: string | null): ScheduleKind | null {
  return commonScheduleOf(schedule)?.kind ?? (schedule === null ? null : 'custom')
}

export function scheduleTimeOf(schedule: string | null): string | null {
  return commonScheduleOf(schedule)?.time ?? null
}

export function scheduleWeekdayOf(schedule: string | null): Weekday | null {
  return commonScheduleOf(schedule)?.weekday ?? null
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
  weekday: Weekday = 1,
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
    return [minute, hour, '*', '*', String(weekday)].join(' ')
  }
  return [minute, hour, '1', '*', '*'].join(' ')
}

export const DEFAULT_SCHEDULE = scheduleFor('daily')

const SCHEDULE_LABEL: Record<Exclude<CommonScheduleKind, 'hourly' | 'weekly'>, string> = {
  daily: '每天',
  weekdays: '每工作日',
  monthly: '每月 1 号',
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
    return '每小时'
  }
  const time = common.time ?? DEFAULT_SCHEDULE_TIME
  if (common.kind === 'weekly') {
    return `每${WEEKDAY_LABELS[common.weekday ?? 1]} ${time}`
  }
  return `${SCHEDULE_LABEL[common.kind]} ${time}`
}

/* 新建任务的空草稿：时区与工作区由调用方按当时的上下文补上。 */
export const BLANK_DRAFT: AutomationDraft = {
  title: '',
  prompt: '',
  schedule: { cron: null, timeZone: '' },
  workspaceId: '',
  posture: 'auto-edit',
  model: null,
  thinking: null,
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
  }
}

/** 草稿与基线是否同一份「形状」：编辑页用它判脏。 */
export function sameDraft(left: AutomationDraft, right: AutomationDraft): boolean {
  return (
    left.title === right.title &&
    left.prompt === right.prompt &&
    left.schedule.cron === right.schedule.cron &&
    left.schedule.timeZone === right.schedule.timeZone &&
    left.workspaceId === right.workspaceId &&
    left.posture === right.posture &&
    (left.model?.provider ?? null) === (right.model?.provider ?? null) &&
    (left.model?.id ?? null) === (right.model?.id ?? null) &&
    left.thinking === right.thinking
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
