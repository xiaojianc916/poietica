import './omp-home'
import { describe, expect, test } from 'bun:test'
import type { EngineSessionEvent } from '@poietica/engine'
import type { Logger, LogLevel } from '@poietica/foundation'
import { applyOps, emptyTimeline } from '@poietica/transcript'
import { fakeOmpSession } from '../projector/__tests__/fixtures/omp-session'

/*
 * omp notice 的上屏规则（R-09）：info 级只落日志，不上时间线。
 *
 * omp 把 notice 当作给 TUI 状态栏的带外提示（xd:// 挂载、协作者进出、慢速模式……），
 * 这些不是对话内容；warning / error 才需要人看到。未知级别按 info 处理。
 */

interface LogRecord {
  readonly level: LogLevel
  readonly msg: string
  readonly data: Readonly<Record<string, unknown>>
}

/** 记录型 logger：engine-omp 没有 test-kit 依赖，就在本地写一个最小实现 */
function recordingLogger(): Logger & { readonly records: LogRecord[] } {
  const records: LogRecord[] = []
  const logger: Logger & { readonly records: LogRecord[] } = {
    records,
    debug: (msg, data) => {
      records.push({ level: 'debug', msg, data: data ?? {} })
    },
    info: (msg, data) => {
      records.push({ level: 'info', msg, data: data ?? {} })
    },
    warn: (msg, data) => {
      records.push({ level: 'warn', msg, data: data ?? {} })
    },
    error: (msg, data) => {
      records.push({ level: 'error', msg, data: data ?? {} })
    },
    child: () => logger,
  }
  return logger
}

interface Notice {
  readonly level: string
  readonly source: string | undefined
  readonly message: string
}

/** 事件流里所有 notice 帧，按到达顺序 */
function noticesOf(events: readonly EngineSessionEvent[]): Notice[] {
  const ops = events.flatMap((event) => (event.type === 'timeline' ? event.ops : []))
  const state = applyOps(emptyTimeline(), ops)
  const out: Notice[] = []
  for (const item of state.items) {
    if (item.kind !== 'turn') continue
    for (const step of item.steps)
      for (const frame of step.frames) {
        if (frame.kind === 'notice') out.push({ level: frame.level, source: frame.source, message: frame.message })
      }
  }
  return out
}

/** 全部帧的 `kind:frameId`，按顺序；用来断言 info 不占帧号 */
function frameIds(events: readonly EngineSessionEvent[]): string[] {
  const ops = events.flatMap((event) => (event.type === 'timeline' ? event.ops : []))
  const state = applyOps(emptyTimeline(), ops)
  const out: string[] = []
  for (const item of state.items) {
    if (item.kind !== 'turn') continue
    for (const step of item.steps) for (const frame of step.frames) out.push(`${frame.kind}:${frame.frameId}`)
  }
  return out
}

const SUBMIT = { text: '发一句', images: [], files: [], skills: [], deliverAs: 'turn' } as const

describe('omp notice 上屏规则（R-09）', () => {
  test('N1 info 级 notice 不上屏，只落 debug 日志（带 source）', async () => {
    const logger = recordingLogger()
    const fake = await fakeOmpSession({ logger })
    await fake.session.submit(SUBMIT)
    fake.feed({
      type: 'notice',
      level: 'info',
      message: 'xd://: mounted mcp__chrome_devtools_click',
      source: 'xdev',
    })

    expect(noticesOf(fake.events)).toEqual([])
    const logged = logger.records.find((record) => record.msg === 'omp notice')
    expect(logged?.level).toBe('debug')
    expect(logged?.data.source).toBe('xdev')
    expect(String(logged?.data.message)).toContain('mounted')
  })

  test('N2 warning 级 notice 照常上屏', async () => {
    const fake = await fakeOmpSession()
    await fake.session.submit(SUBMIT)
    fake.feed({ type: 'notice', level: 'warning', message: '小心', source: 'prewalk' })

    const notices = noticesOf(fake.events)
    expect(notices.length).toBe(1)
    expect(notices[0]?.level).toBe('warning')
    expect(notices[0]?.source).toBe('prewalk')
  })

  test('N3 error 级 notice 照常上屏', async () => {
    const fake = await fakeOmpSession()
    await fake.session.submit(SUBMIT)
    fake.feed({ type: 'notice', level: 'error', message: '坏了', source: 'collab' })

    const notices = noticesOf(fake.events)
    expect(notices.length).toBe(1)
    expect(notices[0]?.level).toBe('error')
  })

  test('N4 未知级别按 info 处理，不上屏', async () => {
    const fake = await fakeOmpSession()
    await fake.session.submit(SUBMIT)
    fake.feed({ type: 'notice', level: 'verbose', message: '将来的级别' })

    expect(noticesOf(fake.events)).toEqual([])
  })

  test('N5 info 不占帧号：两条会话的正文帧号完全一致', async () => {
    const plain = await fakeOmpSession()
    await plain.session.submit(SUBMIT)
    plain.feed({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '你好' } })

    const withInfo = await fakeOmpSession()
    await withInfo.session.submit(SUBMIT)
    withInfo.feed({ type: 'notice', level: 'info', message: 'xd://: mounted mcp__a', source: 'xdev' })
    withInfo.feed({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '你好' } })

    expect(frameIds(withInfo.events)).toEqual(frameIds(plain.events))
  })
})
