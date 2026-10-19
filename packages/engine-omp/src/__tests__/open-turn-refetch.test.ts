import { describe, expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { EngineSessionEvent, EngineToolSpec } from '@poietica/engine'
import { noopLogger } from '@poietica/foundation'
import type { DataLayout } from '@poietica/runtime-layout'
import {
  applyOps,
  emptyTimeline,
  pageFromState,
  stateFromPage,
  type TimelineState,
  type TranscriptOperation,
  type TranscriptPage,
} from '@poietica/transcript'
import { z } from 'zod'
import { type OmpMessage, projectHistoryPage } from '../projector/history'
import { LiveProjector } from '../projector/live'
import { OpenTurnScreen, overlayOpenTurn } from '../projector/open-turn'
import { createOmpEngineForTest } from '../testing'
import { testLayout } from './omp-home'

/*
 * 一轮还开着时整页重取（补发缺口、重新订阅、副本重建），之后的实时增量必须接得上。
 *
 * 从前整页里开着的那一轮取的是历史投影的版本：段的划分与实时那条路不同、也看不到 omp 还在流的那条消息，
 * 之后的增量落在另一套段号上 —— 正在跑的工具出现两张卡片（一张永远转圈），正在流的正文每个增量都报一次缺口。
 * 判据一律是：「重取 + 之后的增量」叠出来的屏幕 = 一直在线的那块屏幕。
 */

/** 屏幕的骨架：每一轮的状态、每一段的号与它装的帧（号、种类、正文 / 工具状态） */
function shape(page: TranscriptPage): unknown[] {
  return page.items.map((item) =>
    item.kind !== 'turn'
      ? item.kind
      : {
          turn: item.turnId,
          state: item.state,
          steps: item.steps.map((step) => ({
            step: step.stepId,
            frames: step.frames.map((frame) =>
              frame.kind === 'text' || frame.kind === 'thinking'
                ? `${frame.frameId}:${frame.kind}=${frame.text}`
                : frame.kind === 'tool'
                  ? `${frame.frameId}:tool=${frame.state}`
                  : `${frame.frameId}:${frame.kind}`,
            ),
          })),
        },
  )
}

function replay(state: TimelineState, ops: readonly (readonly TranscriptOperation[])[]): TimelineState {
  return ops.reduce((next, batch) => applyOps(next, batch), state)
}

describe('一轮开着时整页重取（真 omp）', () => {
  test('O-1 工具正在跑时重取：之后的增量接得上 —— 不多出一张永远转圈的工具卡片', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let blocked = false
    const slow: EngineToolSpec<z.ZodObject<{ text: z.ZodString }>> = {
      name: 'slow_test',
      label: 'slow',
      description: 'slow',
      parameters: z.object({ text: z.string() }),
      approval: 'read',
      execute: async (args) => {
        if (args.text === 'y') {
          blocked = true
          await gate
        }
        return { text: `done:${args.text}` }
      },
    }
    const cwd = await mkdtemp(path.join(tmpdir(), 'poietica-open-turn-'))
    const handle = await createOmpEngineForTest({ layout: testLayout as DataLayout, logger: noopLogger, relayPort: 0 })
    handle.engine.registerTool(slow)
    await handle.engine.freezeTools()
    const session = await handle.engine.openSession({
      key: 'open-turn',
      cwd,
      sessionFile: null,
      posture: 'full-access',
      model: null,
      thinking: null,
    })
    const events: EngineSessionEvent[] = []
    session.subscribe((event) => events.push(event))
    handle.script([
      [
        { kind: 'tool', name: 'slow_test', args: { text: 'x' }, result: '' },
        { kind: 'tool', name: 'slow_test', args: { text: 'y' }, result: '' },
        { kind: 'text', text: '做完了' },
      ],
    ])
    try {
      await session.submit({ text: '问', images: [], files: [], skills: [], deliverAs: 'turn' })
      const deadline = Date.now() + 5000
      while (!blocked) {
        if (Date.now() > deadline) throw new Error('等不到第二个工具开跑')
        await Bun.sleep(5)
      }
      await Bun.sleep(20)
      const mid = await session.page('main', null)
      const seen = events.length
      release()
      while (!events.some((event) => event.type === 'state' && event.state === 'idle')) {
        if (Date.now() > deadline) throw new Error('等不到这一轮收尾')
        await Bun.sleep(5)
      }
      await Bun.sleep(50)
      const batches = (from: number) =>
        events.slice(from).flatMap((event) => (event.type === 'timeline' ? [event.ops] : []))
      const live = replay(emptyTimeline(), batches(0))
      const recovered = replay(stateFromPage(mid), batches(seen))
      expect(shape(pageFromState(recovered))).toEqual(shape(pageFromState(live)))
      const tools = pageFromState(recovered)
        .items.flatMap((item) => (item.kind === 'turn' ? item.steps.flatMap((step) => step.frames) : []))
        .filter((frame) => frame.kind === 'tool')
      expect(tools.map((frame) => (frame.kind === 'tool' ? frame.state : ''))).toEqual(['done', 'done'])
    } finally {
      release()
      await session.dispose()
      await handle.engine.dispose()
    }
  }, 20_000)
})

/* —— 下面两例只用两条投影本身：omp 的流式增量与「还没写进消息」的那一刻用真 omp 停不住 —— */

const at = (second: number) => Date.UTC(2026, 0, 1, 0, 0, second)
const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } }
const user = (text: string, second: number): OmpMessage =>
  ({ role: 'user', content: text, timestamp: at(second) }) as unknown as OmpMessage
const reply = (text: string, second: number): OmpMessage =>
  ({
    role: 'assistant',
    content: [{ type: 'text', text }],
    stopReason: 'stop',
    usage: ZERO,
    timestamp: at(second),
  }) as unknown as OmpMessage

/** 实时那条路：投影器 + 屏幕副本，像 OmpSession.timeline 那样每批都记一份 */
function liveRig(seat: number) {
  let clock = at(30)
  const projector = new LiveProjector({ now: () => (clock += 1000) })
  projector.seat(seat)
  const screen = new OpenTurnScreen()
  const sent: TranscriptOperation[][] = []
  const emit = (ops: TranscriptOperation[]) => {
    screen.observe(ops)
    sent.push(ops)
  }
  return { projector, screen, sent, emit }
}

describe('一轮开着时整页重取（两条投影）', () => {
  test('O-2 正文还在流时重取：下一条 append 接得上，不报缺口', () => {
    const rig = liveRig(0)
    rig.emit(rig.projector.userTurn({ text: '问' }))
    rig.projector.assistantMessageStart()
    rig.emit(rig.projector.textDelta('一半', 0))
    /* omp 的消息里此刻只有那句人话：还在流的助手消息要到 message_end 才写进去 */
    const history = projectHistoryPage([user('问', 30)], null, { isTurnOpen: false })
    const mid = overlayOpenTurn(history, rig.screen.view(), true)
    const seen = rig.sent.length
    rig.emit(rig.projector.textDelta('，另一半', 0))
    const recovered = replay(stateFromPage(mid), rig.sent.slice(seen))
    expect(shape(pageFromState(recovered))).toEqual(shape(pageFromState(replay(emptyTimeline(), rig.sent))))

    /* 旧做法：开着的这一轮取历史投影的版本 —— 没有这一帧，append 的 offset 对不上 */
    const old = projectHistoryPage([user('问', 30)], null, { isTurnOpen: true })
    expect(() => replay(stateFromPage(old), rig.sent.slice(seen))).toThrow()
  })

  test('O-3 omp 还没写进这句话时重取：上一轮不被标成 running，开着的这一轮在末尾', () => {
    const sealed = [user('第一句', 1), reply('第一答', 2)]
    const rig = liveRig(1)
    rig.emit(rig.projector.userTurn({ text: '第二句' }))
    const page = overlayOpenTurn(projectHistoryPage(sealed, null, { isTurnOpen: false }), rig.screen.view(), true)
    expect(page.items.map((item) => (item.kind === 'turn' ? `${item.turnId}:${item.state}` : item.kind))).toEqual([
      't1:completed',
      't2:running',
    ])

    /* 旧做法：最新一轮（其实是上一轮）被标成 running，开着的这一轮不在页里 */
    const old = projectHistoryPage(sealed, null, { isTurnOpen: true })
    expect(old.items.map((item) => (item.kind === 'turn' ? `${item.turnId}:${item.state}` : item.kind))).toEqual([
      't1:running',
    ])
  })

  test('O-4 这一轮收口之后屏幕副本放手：整页完全由历史投影决定', () => {
    const rig = liveRig(0)
    rig.emit(rig.projector.userTurn({ text: '问' }))
    rig.projector.assistantMessageStart()
    rig.emit(rig.projector.textDelta('答', 0))
    rig.emit(rig.projector.turnEnd('completed', null))
    expect(rig.screen.view()).toBeNull()
    const history = projectHistoryPage([user('问', 30), reply('答', 31)], null, {})
    expect(overlayOpenTurn(history, rig.screen.view(), true)).toBe(history)
  })
})
