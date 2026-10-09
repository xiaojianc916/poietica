import { Cron } from 'croner'

export type ScheduleProblem = 'unreadable' | 'never_runs' | 'too_frequent' | 'time_zone'
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

export const PROBLEM_TEXT: Record<ScheduleProblem, string> = {
  unreadable: '读不懂这段 crontab 表达式',
  never_runs: '这段表达式没有下一次运行',
  too_frequent: '最小调度粒度为一分钟：秒字段只能命中一个值',
  time_zone: '不是有效的 IANA 时区',
}
