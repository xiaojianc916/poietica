import { Cron } from 'croner'

import type { Schedule } from '../contract/entities'

export type ScheduleProblem = 'unreadable' | 'never_runs' | 'too_frequent' | 'time_zone' | 'in_past' | 'conflict'
export interface ScheduleResult {
  readonly next: number | null
  readonly problem: ScheduleProblem | null
}

function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

const CRON_OPTIONS = { domAndDow: false, sloppyRanges: true } as const

/** 与 legacy 相同的规则：不接受 '?'；秒字段可省略；最小粒度一分钟（秒字段必须恰好命中一个值） */
function parse(expression: string, timeZone: string): Cron | ScheduleProblem {
  if (expression.includes('?')) return 'unreadable'
  let cron: Cron
  try {
    cron = new Cron(expression, { timezone: timeZone, paused: true, ...CRON_OPTIONS })
  } catch {
    return 'unreadable'
  }
  const fields = expression.trim().split(/\s+/)
  if (fields.length === 6) {
    const sec = fields[0]!
    if (!/^\d{1,2}$/.test(sec) || Number(sec) > 59) return 'too_frequent'
  }
  return cron
}

export function nextAfter(cron: string | null, timeZone: string, now: number): ScheduleResult {
  if (!validTimeZone(timeZone)) return { next: null, problem: 'time_zone' }
  if (cron === null) return { next: null, problem: null }
  const parsed = parse(cron, timeZone)
  if (typeof parsed === 'string') return { next: null, problem: parsed }
  const next = parsed.nextRun(new Date(now))
  return next === null ? { next: null, problem: 'never_runs' } : { next: next.getTime(), problem: null }
}

export function preview(
  cron: string | null,
  timeZone: string,
  now: number,
  count: number,
): { times: number[]; problem: ScheduleProblem | null } {
  const times: number[] = []
  let cursor = now
  for (let i = 0; i < count; i++) {
    const r = nextAfter(cron, timeZone, cursor)
    if (r.problem !== null) return { times, problem: times.length === 0 ? r.problem : null }
    if (r.next === null) break
    times.push(r.next)
    cursor = r.next
  }
  return { times, problem: null }
}

/**
 * 一份完整计划（周期 / 一次性 / 只手动）的下一次运行（审查 R-14）。
 *
 * 一次性计划的时间已经过去时：`next` 为 null，problem 为 in_past —— 由调用方决定它算不算问题
 * （新建 / 改时间时是错误；已经跑过的一次性任务只是「做完了」，见 service.recompute）。
 */
export function nextOf(schedule: Schedule, now: number): ScheduleResult {
  if (!validTimeZone(schedule.timeZone)) return { next: null, problem: 'time_zone' }
  if (schedule.cron !== null && schedule.at !== null) return { next: null, problem: 'conflict' }
  if (schedule.at !== null)
    return schedule.at > now ? { next: schedule.at, problem: null } : { next: null, problem: 'in_past' }
  return nextAfter(schedule.cron, schedule.timeZone, now)
}

/** 预览未来若干次：一次性计划最多一次 */
export function previewOf(
  schedule: Schedule,
  now: number,
  count: number,
): { times: number[]; problem: ScheduleProblem | null } {
  if (schedule.at === null) {
    if (!validTimeZone(schedule.timeZone)) return { times: [], problem: 'time_zone' }
    return preview(schedule.cron, schedule.timeZone, now, count)
  }
  const r = nextOf(schedule, now)
  return r.next === null ? { times: [], problem: r.problem } : { times: [r.next], problem: null }
}

export const PROBLEM_TEXT: Record<ScheduleProblem, string> = {
  unreadable: '读不懂这段 crontab 表达式',
  never_runs: '这段表达式没有下一次运行',
  too_frequent: '最小调度粒度为一分钟：秒字段只能命中一个值',
  time_zone: '不是有效的 IANA 时区',
  in_past: '一次性任务的运行时间已经过去',
  conflict: '周期计划与一次性时间只能二选一',
}
