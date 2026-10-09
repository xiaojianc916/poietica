import { describe, expect, test } from 'bun:test'
import type { QueueSnapshot } from '@poietica/engine'
import type { TranscriptOperation } from '@poietica/transcript'
import type { TranscriptSignal } from '../../agent/transcript'
import type { ConversationApi } from '../../api'
import { createSessionPort } from '../session-port'

/*
 * 会话端口的按号撤回 / 换层（R-01 §5.3）。
 *
 * 旧实现不带号：从快照里挑「第一条 steer，否则第一条」撤掉 —— 屏幕上的撤回键画在最后
 * 一行，撤的却是别条（R-01 §1 缺陷 D）。这一层现在只做两件事：按号点名交给契约，
 * 并把撤走那一项的正文如实交回。
 */
const QUEUE: QueueSnapshot = {
  items: [
    { id: 'F1', text: '第一条', deliverAs: 'followUp', createdAt: 1 },
    { id: 'F2', text: '第二条', deliverAs: 'followUp', createdAt: 2 },
  ],
  modes: { steer: 'all', followUp: 'all' },
}

function fakeApi() {
  const withdrawn: { threadId: string; itemId: string }[] = []
  const moved: { threadId: string; itemId: string; deliverAs: 'steer' | 'followUp' }[] = []
  const api = {
    getQueue: async () => QUEUE,
    withdraw: async (threadId: string, itemId: string) => {
      withdrawn.push({ threadId, itemId })
      return QUEUE
    },
    move: async (threadId: string, itemId: string, deliverAs: 'steer' | 'followUp') => {
      moved.push({ threadId, itemId, deliverAs })
      return QUEUE
    },
  } as unknown as ConversationApi
  return { api, withdrawn, moved }
}

describe('会话端口的按号撤回（R-01 §5.3）', () => {
  test('撤回第二条时点名 F2，交回它的正文', async () => {
    const { api, withdrawn } = fakeApi()
    const port = createSessionPort({ api, threadId: 'th' })

    const restored = await port.withdraw('F2')

    expect(withdrawn).toEqual([{ threadId: 'th', itemId: 'F2' }])
    expect(restored).toEqual({ text: '第二条' })
  })

  test('号不在快照里（已被消费）时什么也不做，交回 null', async () => {
    const { api, withdrawn } = fakeApi()
    const port = createSessionPort({ api, threadId: 'th' })

    expect(await port.withdraw('gone')).toBeNull()
    expect(withdrawn).toEqual([])
  })

  test('换层把号与目标层交给 queue.move', async () => {
    const { api, moved } = fakeApi()
    const port = createSessionPort({ api, threadId: 'th' })

    const next = await port.move('F1', 'steer')

    expect(moved).toEqual([{ threadId: 'th', itemId: 'F1', deliverAs: 'steer' }])
    expect(next.followUp.map((item) => item.id)).toEqual(['F1', 'F2'])
  })
})

/*
 * R-04 S2/S3：端口必须把 epoch 换代当成「换代」交出去，旧页要带**真实 seq**。
 *
 * 旧实现在 `epochs` 表里只记 epoch，从不比较：Core 重启后新进程的 seq 从 1 重新开始，
 * legacy 副本看到 `seq <= feed.seq`（旧水位几百到几千）就把整批新数据当重复丢掉 ——
 * 屏幕上时间线冻结（R-04 §1.2）。翻页那条同理：旧代码把 epoch 填进 seq，
 * 副本的「历史游标不倒走」不变式必然抛错（R-04 §1.3）。
 */
function fakeTimelineApi() {
  let ops:
    | ((p: { threadId: string; agentId: string; epoch: number; seq: number; ops: TranscriptOperation[] }) => void)
    | null = null
  let reset: ((p: { threadId: string; agentId: string; epoch: number }) => void) | null = null
  const pages: string[] = []
  const api = {
    onTimelineOps: (l: NonNullable<typeof ops>) => {
      ops = l
      return { dispose: () => undefined }
    },
    onTimelineReset: (l: NonNullable<typeof reset>) => {
      reset = l
      return { dispose: () => undefined }
    },
    timelinePage: async (_threadId: string, agentId: string, beforeTurnId: string | null) => {
      pages.push(beforeTurnId ?? '')
      return {
        items: [],
        tasks: [],
        interactions: [],
        attachments: [],
        todos: [],
        prompts: [],
        meta: {},
        hasMoreOlder: false,
        agentId,
      }
    },
    getQueue: async () => QUEUE,
  } as unknown as ConversationApi
  return {
    api,
    pages,
    emitOps: (p: { agentId: string; epoch: number; seq: number; ops: TranscriptOperation[] }) =>
      ops?.({ threadId: 'th', ...p }),
    emitReset: (p: { agentId: string; epoch: number }) => reset?.({ threadId: 'th', ...p }),
  }
}

describe('会话端口的 epoch + seq 位置（R-04 §3.3）', () => {
  test('R-04 S2 epoch 变化：交回 reset，而不是把新进程的 seq=1 当增量', () => {
    const { api, emitOps } = fakeTimelineApi()
    const port = createSessionPort({ api, threadId: 'th' })
    const signals: TranscriptSignal[] = []
    port.transcript.subscribeTranscript((s) => signals.push(s))

    emitOps({ agentId: 'main', epoch: 7, seq: 5, ops: [] })
    emitOps({ agentId: 'main', epoch: 9, seq: 1, ops: [] })

    expect(signals.map((s) => [s.kind, 'seq' in s ? s.seq : undefined])).toEqual([
      ['ops', 5],
      ['reset', undefined],
    ])
  })

  test('R-04 S2b 同一 epoch 内照常交增量（换代判据不误伤）', () => {
    const { api, emitOps } = fakeTimelineApi()
    const port = createSessionPort({ api, threadId: 'th' })
    const signals: TranscriptSignal[] = []
    port.transcript.subscribeTranscript((s) => signals.push(s))

    emitOps({ agentId: 'main', epoch: 7, seq: 5, ops: [] })
    emitOps({ agentId: 'main', epoch: 7, seq: 6, ops: [] })

    expect(signals.map((s) => s.kind)).toEqual(['ops', 'ops'])
  })

  test('R-04 S2c reset 通知把位置换到新 epoch 的水位 0', () => {
    const { api, emitOps, emitReset } = fakeTimelineApi()
    const port = createSessionPort({ api, threadId: 'th' })
    const signals: TranscriptSignal[] = []
    port.transcript.subscribeTranscript((s) => signals.push(s))

    emitOps({ agentId: 'main', epoch: 7, seq: 5, ops: [] })
    emitReset({ agentId: 'main', epoch: 9 })
    /* reset 之后同代的增量正常交出去（seq=1 是新水位的第一批，不是重复）。 */
    emitOps({ agentId: 'main', epoch: 9, seq: 1, ops: [] })

    expect(signals.map((s) => s.kind)).toEqual(['ops', 'reset', 'ops'])
  })

  test('R-04 S3 旧页带真实 seq（不是 epoch）', async () => {
    const { api, emitOps, pages } = fakeTimelineApi()
    const port = createSessionPort({ api, threadId: 'th' })
    port.transcript.subscribeTranscript(() => undefined)
    emitOps({ agentId: 'main', epoch: 7, seq: 40, ops: [] })

    const older = await port.transcript.readTranscript('th', 'main', 'turnX')

    expect(pages).toEqual(['turnX'])
    expect(older.seq).toBe(40)
  })
})
