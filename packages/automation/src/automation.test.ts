import { describe, expect, it } from 'bun:test'
import type { Automation, AutomationRunOutcome } from '@poietica/contract/automation'
import {
  DEFAULT_SCHEDULE,
  describeMoment,
  describeSchedule,
  isTerminal,
  RUN_LABELS,
  scheduleFor,
  scheduleKindOf,
  scheduleTimeOf,
  summarize,
} from './automation'

describe('describeSchedule', () => {
  it('常见日程是人话，自定义日程保留原文', () => {
    expect(describeSchedule(null)).toBe('手动')
    expect(describeSchedule('0 9 * * *')).toBe('每天 09:00')
    expect(describeSchedule('0 9 * * 1-5')).toBe('每工作日 09:00')
    expect(describeSchedule('*/30 * * * *')).toBe('*/30 * * * *')
  })
})

describe('structured schedule projection', () => {
  it('常见日程在意图和 cron 之间往返', () => {
    expect(scheduleFor('hourly')).toBe('0 * * * *')
    expect(scheduleFor('daily', '09:05')).toBe('5 9 * * *')
    expect(scheduleFor('weekdays', '09:05')).toBe('5 9 * * 1-5')
    expect(scheduleFor('weekly', '09:05')).toBe('5 9 * * 1')
    expect(scheduleFor('monthly', '09:05')).toBe('5 9 1 * *')
    expect(scheduleFor('daily')).toBe(DEFAULT_SCHEDULE)
  })

  it('只把产品生成的形状识别成常见日程', () => {
    expect(scheduleKindOf('5 9 * * 1-5')).toBe('weekdays')
    expect(scheduleTimeOf('5 9 * * 1-5')).toBe('09:05')
    expect(scheduleKindOf('*/30 * * * *')).toBe('custom')
    expect(scheduleKindOf(null)).toBeNull()
  })

  it('拒绝非标准时间值', () => {
    expect(() => scheduleFor('daily', '9:00')).toThrow('无效时间')
  })
})

it('only confirmed failures count as failures', () => {
  const outcomes: AutomationRunOutcome[] = [
    'queued',
    'dispatching',
    'running',
    'cancelling',
    'uncertain',
    'succeeded',
    'failed',
    'cancelled',
  ]
  const row: Automation = {
    id: 'definition',
    title: 'Review',
    prompt: 'Inspect',
    schedule: null,
    enabled: false,
    revision: 1,
    createdAt: '2026-01-01T00:00:00Z',
    nextRunAt: null,
    workspaceRoot: '/workspace',
    timeZone: 'UTC',
    issue: null,
    sessionConfig: {},
    runs: outcomes.map((outcome) => ({
      id: outcome,
      threadId: null,
      startedAt: '2026-01-01T00:00:00Z',
      settledAt: null,
      scheduledFor: null,
      message: null,
      outcome,
    })),
  }
  expect(summarize([row], Date.parse('2026-01-02T00:00:00Z'))).toEqual({
    total: 1,
    succeeded: 1,
    failed: 1,
  })
  expect(outcomes.filter(isTerminal)).toEqual(['succeeded', 'failed', 'cancelled'])
  expect(Object.keys(RUN_LABELS).sort()).toEqual([...outcomes].sort())
  expect(describeMoment('invalid')).toBe('时间不可用')
})
