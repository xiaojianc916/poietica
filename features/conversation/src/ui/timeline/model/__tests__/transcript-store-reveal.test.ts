import { expect, test } from 'bun:test'
import { applyOps, emptyTimeline, type TranscriptOperation } from '@poietica/transcript'
import type { AgentSessionPort } from '../../../shared/model/session'
import type { TranscriptPage } from '../../../shared/model/transcript'
import { TranscriptStore } from '../transcript-store'

/*
 * minimap 跳到一轮还没载入的历史：一次往返读够（throughTurnId），`revealing` 在这一趟里点亮、回来后熄灭；
 * 连点两格时只有最后一次点击持有忙碌态。
 */

const AT = '2026-10-10T00:00:00.000Z'
const TOTAL = 100

function turnsOf(from: number, to: number): TranscriptOperation[] {
  const ops: unknown[] = []
  for (let n = from; n <= to; n += 1) {
    const turnId = `t${n}`
    const stepId = `${turnId}:s0`
    ops.push(
      {
        op: 'turn.upsert',
        turn: {
          kind: 'turn',
          turnId,
          ordinal: n,
          state: 'completed',
          origin: { kind: 'user' },
          prompt: `问 ${n}`,
          startedAt: AT,
          endedAt: AT,
        },
      },
      {
        op: 'step.upsert',
        turnId,
        step: { kind: 'step', stepId, turnId, ordinal: 0, state: 'completed', startedAt: AT, endedAt: AT },
      },
    )
  }
  return ops as TranscriptOperation[]
}

function pageOf(from: number, to: number, head: boolean): TranscriptPage {
  const outline = Array.from({ length: TOTAL }, (_, at) => ({
    turnId: `t${at + 1}`,
    ordinal: at + 1,
    prompt: `问 ${at + 1}`,
  }))
  return {
    ...applyOps(emptyTimeline(), turnsOf(from, to)),
    tasks: [],
    interactions: [],
    attachments: [],
    todos: [],
    prompts: [],
    meta: {},
    hasMoreOlder: from > 1,
    agentId: 'main',
    agents: [],
    pendingInteractions: [],
    seq: 1,
    ...(head ? { outline } : {}),
  } as unknown as TranscriptPage
}

type Read = { before?: string; through?: string; release: () => void }

function pagingPort() {
  const reads: Read[] = []
  const port = {
    transcript: {
      subscribeTranscript: () => () => undefined,
      readTranscript: (_sessionId: string, _agentId: string, before?: string, through?: string) => {
        if (before === undefined) {
          return Promise.resolve(pageOf(TOTAL - 19, TOTAL, true))
        }
        const end = Number(before.slice(1)) - 1
        const start = through === undefined ? Math.max(1, end - 19) : Math.min(Number(through.slice(1)), end - 19)
        return new Promise<TranscriptPage>((resolve) => {
          reads.push({ before, through, release: () => resolve(pageOf(Math.max(1, start), end, false)) })
        })
      },
      catchUpTranscript: async (_sessionId: string, agentId: string, sinceSeq: number) => ({
        agentId,
        batches: [],
        latestSeq: sinceSeq,
        complete: true,
      }),
    },
    readQueue: async () => ({ threadId: 'T', steering: [], followUp: [] }),
    subscribeQueue: () => () => undefined,
    subscribePromptDropped: () => () => undefined,
    subscribeRunFailed: () => () => undefined,
  } as unknown as AgentSessionPort
  return { port, reads }
}

async function opened() {
  const held = pagingPort()
  const store = new TranscriptStore({ sessions: () => held.port })
  store.open('T')
  await Bun.sleep(0)
  return { store, reads: held.reads }
}

const mark = (n: number) => ({ turnId: `t${n}`, admissionId: `t${n}`, prompt: `问 ${n}`, reply: null })

test('R1 头页就给出整条对话的轨道：100 格，不是已载入的 20 格', async () => {
  const { store } = await opened()
  expect(store.read('T').earlier).toBe('t81')
  expect(store.read('T').outline.length).toBe(TOTAL)
  expect(store.read('T').outline[0]?.turnId).toBe('t1')
})

test('R2 跳到第 7 轮：一次往返、带 throughTurnId；在途点亮 revealing，回来后熄灭', async () => {
  const { store, reads } = await opened()
  const going = store.revealTurn('T', mark(7))
  await Bun.sleep(0)

  expect(reads.map(({ before, through }) => [before, through])).toEqual([['t81', 't7']])
  expect(store.read('T').revealing).toBe('t7')

  reads[0]?.release()
  await going
  expect(reads.length).toBe(1)
  expect(store.read('T').revealing).toBeNull()
  expect(store.read('T').earlier).toBe('t7')
  /* 读回来之后轨道长度不变：冷格换成已载入的轮。 */
  expect(store.read('T').outline.length).toBe(TOTAL)
})

test('R3 已经载入的轮：不发请求', async () => {
  const { store, reads } = await opened()
  await store.revealTurn('T', mark(90))
  expect(reads.length).toBe(0)
  expect(store.read('T').revealing).toBeNull()
})

test('R4 连点两格：先回来的那一趟不撤后一趟的忙碌态', async () => {
  const { store, reads } = await opened()
  const first = store.revealTurn('T', mark(50))
  await Bun.sleep(0)
  const second = store.revealTurn('T', mark(3))
  await Bun.sleep(0)
  expect(store.read('T').revealing).toBe('t3')

  reads[0]?.release()
  await first
  expect(store.read('T').revealing).toBe('t3')

  while (reads.length < 2) await Bun.sleep(0)
  reads[1]?.release()
  await second
  expect(store.read('T').revealing).toBeNull()
})
