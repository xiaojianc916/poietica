import { describe, expect, test } from 'bun:test'
import type { TranscriptOperation, TranscriptPage } from '@poietica/transcript'
import type { ConversationApi } from '../../api'
import { TimelineReplica } from '../timeline-replica'

/*
 * CV-11：UI 副本的四种不一致都要能自愈 —— 缺口 → catchUp；catchUp 不完整 → 重新订阅；
 * epoch 不同 → 重新订阅；订阅返回前到达的批次被缓存并按序应用。
 */

const page = (text: string): TranscriptPage =>
  ({
    items: [
      {
        kind: 'turn',
        turnId: 't1',
        ordinal: 1,
        state: 'completed',
        origin: { kind: 'user' },
        prompt: text,
        steps: [],
      },
    ],
    tasks: [],
    interactions: [],
    attachments: [],
    todos: [],
    prompts: [],
    meta: {},
    hasMoreOlder: false,
  }) as unknown as TranscriptPage

/** 只实现副本用到的那几个方法；其它方法在这里不该被调用 */
function fakeApi(overrides: Partial<ConversationApi> & { readonly snapshots?: TranscriptPage[] } = {}) {
  const calls: string[] = []
  let snapshotIndex = 0
  const snapshots = overrides.snapshots ?? [page('第一次订阅')]
  const api = {
    subscribeTimeline: async () => {
      calls.push('subscribe')
      const next = snapshots[Math.min(snapshotIndex, snapshots.length - 1)]!
      snapshotIndex += 1
      return { page: next, epoch: 1, seq: 0, submissions: [] }
    },
    unsubscribeTimeline: async () => {
      calls.push('unsubscribe')
    },
    timelinePage: async () => page('更早'),
    catchUp: async () => ({ batches: [], latestSeq: 0, complete: false }),
    ...overrides,
  } as unknown as ConversationApi
  return { api, calls }
}

const ops = (text: string): TranscriptOperation[] =>
  [{ op: 'append', target: { type: 'task', taskId: 'x' }, offset: 0, text }] as unknown as TranscriptOperation[]

describe('CV-11 TimelineReplica 的一致性协议（05 页 §12.2）', () => {
  test('订阅成功后 status 变 live，状态由快照建立', async () => {
    const { api, calls } = fakeApi()
    const replica = new TimelineReplica(api, 'th', 'main', () => undefined)
    await replica.resubscribe()
    expect(calls).toContain('subscribe')
    expect(replica.status).toBe('live')
    expect(replica.state).not.toBeNull()
  })

  test('订阅返回前到达的批次被缓存，返回后按序应用', async () => {
    const { api } = fakeApi()
    let batches = 0
    const replica = new TimelineReplica(api, 'th', 'main', () => {
      batches += 1
    })
    const pending = replica.resubscribe()
    // 订阅还没返回：此刻到达的批次进缓冲
    replica.receive({ epoch: 1, seq: 1, ops: ops('a') })
    replica.receive({ epoch: 1, seq: 2, ops: ops('b') })
    await pending
    expect(replica.status).toBe('live')
    expect(batches).toBeGreaterThan(0)
  })

  test('epoch 不同 → 重新订阅', async () => {
    const { api, calls } = fakeApi()
    const replica = new TimelineReplica(api, 'th', 'main', () => undefined)
    await replica.resubscribe()
    replica.receive({ epoch: 99, seq: 1, ops: [] })
    await Promise.resolve()
    await Promise.resolve()
    expect(calls.filter((c) => c === 'subscribe').length).toBeGreaterThanOrEqual(2)
  })

  test('seq 缺口 → 调 catchUp；catchUp 不完整 → 重新订阅', async () => {
    const { api, calls } = fakeApi({
      catchUp: async () => {
        calls.push('catchUp')
        return { batches: [], latestSeq: 5, complete: false }
      },
    })
    const replica = new TimelineReplica(api, 'th', 'main', () => undefined)
    await replica.resubscribe()
    // 跳过 seq=1，直接来 seq=2：缺口
    replica.receive({ epoch: 1, seq: 2, ops: [] })
    await new Promise((r) => setTimeout(r, 0))
    expect(calls).toContain('catchUp')
    expect(calls.filter((c) => c === 'subscribe').length).toBeGreaterThanOrEqual(2)
  })

  test('catchUp 完整时按批次补齐，不重新订阅', async () => {
    let subscribed = 0
    const { api } = fakeApi({
      subscribeTimeline: async () => {
        subscribed += 1
        return { page: page('x'), epoch: 1, seq: 0, submissions: [] }
      },
      catchUp: async () => ({ batches: [{ seq: 1, ops: ops('补') }], latestSeq: 1, complete: true }),
    })
    const replica = new TimelineReplica(api, 'th', 'main', () => undefined)
    await replica.resubscribe()
    replica.receive({ epoch: 1, seq: 2, ops: [] })
    await new Promise((r) => setTimeout(r, 0))
    expect(subscribed).toBe(1)
  })

  test('dispose 之后不再接受增量，并退订通道', async () => {
    const { api, calls } = fakeApi()
    const replica = new TimelineReplica(api, 'th', 'main', () => undefined)
    await replica.resubscribe()
    replica.dispose()
    expect(replica.status).toBe('error')
    expect(calls).toContain('unsubscribe')
  })

  test('loadOlder 在 hasMoreOlder 为假时什么也不做', async () => {
    const { api } = fakeApi()
    const replica = new TimelineReplica(api, 'th', 'main', () => undefined)
    await replica.resubscribe()
    await replica.loadOlder()
    expect(replica.state).not.toBeNull()
  })
})
