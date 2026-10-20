import { describe, expect, test } from 'bun:test'
import type { BtwHistoryRecord } from '@oh-my-pi/pi-coding-agent/session/btw-history'
import { EngineErrorCode } from '@poietica/engine'
import { AppError, Deferred, noopLogger, SystemErrorCode } from '@poietica/foundation'
import { type BtwControllerLike, type BtwFrame, type SideEvent, SideQuestions, topicOf } from '../side-questions'

/*
 * side-questions.ts 的那几条自己的规矩（端口语义由一致性套件 C-SIDE-* 在真 omp 上钉住）：
 * 忙 / 话题不存在 / 没有模型在 omp 之前判掉；开问途中按停止报 cancelled；offset 按已流出的字数配；收口后迟到的一截不认；
 * 关会话时存档失败只记日志。
 */

const record = (patch: Partial<BtwHistoryRecord> = {}): BtwHistoryRecord => ({
  id: 'r1',
  leafId: null,
  question: 'q',
  answer: '',
  status: 'running',
  createdAt: 1,
  updatedAt: 1,
  ...patch,
})

interface Rig {
  readonly side: SideQuestions
  readonly events: SideEvent[]
  output(frame: BtwFrame): void
  controller: BtwControllerLike
}

function rig(overrides: Partial<BtwControllerLike> = {}, hasModel = true): Rig {
  const events: SideEvent[] = []
  let output: (frame: BtwFrame) => void = () => undefined
  const controller: BtwControllerLike = {
    ask: async (question, recordId) => {
      const started = record({ id: recordId ?? 'r1', question })
      output({ type: 'btw_record', record: started })
      return started
    },
    cancel: () => false,
    history: async () => [],
    close: async () => undefined,
    ...overrides,
  }
  const side = new SideQuestions({
    createController: (out) => {
      output = out
      return controller
    },
    hasModel: () => hasModel,
    emit: (event) => events.push(event),
    logger: noopLogger,
  })
  return { side, events, output: (frame) => output(frame), controller }
}

const codeOf = (error: unknown): string | undefined => (error instanceof AppError ? error.code : undefined)

describe('SideQuestions', () => {
  test('omp 的记录摊平成话题：首问在前、追问随后，缺 error 记 null', () => {
    const topic = topicOf(
      record({
        status: 'complete',
        answer: 'a1',
        followUps: [{ question: 'q2', answer: '', status: 'error', createdAt: 2, updatedAt: 3, error: 'boom' }],
      }),
    )
    expect(topic.turns.map((turn) => [turn.question, turn.status, turn.error])).toEqual([
      ['q', 'complete', null],
      ['q2', 'error', 'boom'],
    ])
  })

  test('没有模型、空问题：不去开问', async () => {
    let asked = 0
    const noModel = rig(
      {
        ask: async () => {
          asked++
          return record()
        },
      },
      false,
    )
    expect(codeOf(await noModel.side.ask('hi', null).catch((e: unknown) => e))).toBe(EngineErrorCode.sideUnavailable)
    expect(codeOf(await noModel.side.ask('  ', null).catch((e: unknown) => e))).toBe(SystemErrorCode.invalidParams)
    expect(asked).toBe(0)
  })

  test('追问不存在的话题：先读历史判掉，报 side_topic_unknown', async () => {
    const r = rig({ history: async () => [record({ id: 'other', status: 'complete' })] })
    expect(codeOf(await r.side.ask('more', 'missing').catch((e: unknown) => e))).toBe(EngineErrorCode.sideTopicUnknown)
    expect(r.side.busy).toBe(false)
  })

  test('核对话题号期间按停止：omp 还没进门，由这一层收手并报 cancelled', async () => {
    const gate = new Deferred<readonly BtwHistoryRecord[]>()
    let asked = 0
    const r = rig({
      history: () => gate.promise,
      ask: async () => {
        asked++
        return record()
      },
    })
    const pending = r.side.ask('more', 'r1').catch((e: unknown) => e)
    expect(r.side.busy).toBe(true)
    expect(r.side.cancel(null)).toBe(true)
    gate.resolve([record({ status: 'complete' })])
    expect(codeOf(await pending)).toBe(SystemErrorCode.cancelled)
    expect(asked).toBe(0)
    expect(r.side.busy).toBe(false)
  })

  test('omp 开问途中被停（裸 Error）报 cancelled；其余裸 Error 报 side_failed 并带原文', async () => {
    const stopped = rig({
      ask: async () => {
        stopped.side.cancel(null)
        throw new Error('The /btw question was cancelled before it started')
      },
      cancel: () => true,
    })
    expect(codeOf(await stopped.side.ask('x', null).catch((e: unknown) => e))).toBe(SystemErrorCode.cancelled)
    const broken = rig({
      ask: async () => {
        throw new Error('Could not save /btw history: disk full')
      },
    })
    const error = await broken.side.ask('x', null).catch((e: unknown) => e)
    expect(codeOf(error)).toBe(EngineErrorCode.sideFailed)
    expect((error as AppError).message).toContain('disk full')
  })

  test('流式：offset 按已流出的字数配，收口之后迟到的一截不认；在答期间再问报 side_busy', async () => {
    const r = rig()
    const topic = await r.side.ask('q', null)
    expect(topic.turns[0]?.status).toBe('running')
    expect(r.side.busy).toBe(true)
    expect(codeOf(await r.side.ask('again', null).catch((e: unknown) => e))).toBe(EngineErrorCode.sideBusy)
    r.output({ type: 'btw_delta', recordId: 'r1', delta: '你好' })
    r.output({ type: 'btw_delta', recordId: 'r1', delta: 'abc' })
    r.output({ type: 'btw_delta', recordId: 'someone-else', delta: '??' })
    r.output({ type: 'btw_record', record: record({ status: 'complete', answer: '你好abc' }) })
    r.output({ type: 'btw_delta', recordId: 'r1', delta: 'late' })
    expect(r.side.busy).toBe(false)
    const deltas = r.events.flatMap((event) =>
      event.type === 'sideDelta' ? [[event.turn, event.offset, event.delta]] : [],
    )
    expect(deltas).toEqual([
      [0, 0, '你好'],
      [0, 2, 'abc'],
    ])
    expect(r.events.filter((event) => event.type === 'sideTopic')).toHaveLength(2)
  })

  test('追问：问题下标指向新的那一问，offset 从这一问已有的字数起', async () => {
    const r = rig({
      ask: async (question) => {
        const started = record({
          status: 'complete',
          answer: 'first',
          followUps: [{ question, answer: '', status: 'running', createdAt: 2, updatedAt: 2 }],
        })
        r.output({ type: 'btw_record', record: started })
        return started
      },
      history: async () => [record({ status: 'complete', answer: 'first' })],
    })
    await r.side.ask('second', 'r1')
    r.output({ type: 'btw_delta', recordId: 'r1', delta: 'x' })
    const delta = r.events.find((event) => event.type === 'sideDelta')
    expect(delta?.type === 'sideDelta' ? [delta.turn, delta.offset] : null).toEqual([1, 0])
  })

  test('存档失败的提醒原样转成 sideNotice；关会话时存档失败只记日志、不抛', async () => {
    const r = rig({
      close: async () => {
        throw new Error('still unsaved')
      },
    })
    r.output({ type: 'notice', level: 'error', message: 'Could not save /btw history: EACCES', source: 'btw-history' })
    expect(r.events).toEqual([{ type: 'sideNotice', message: 'Could not save /btw history: EACCES' }])
    await r.side.close()
    await r.side.close()
  })
})
