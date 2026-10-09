import { describe, expect, test } from 'bun:test'
import type { QueueSnapshot } from '@poietica/engine'
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
