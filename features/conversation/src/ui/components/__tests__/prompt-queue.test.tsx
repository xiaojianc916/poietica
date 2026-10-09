import { describe, expect, test } from 'bun:test'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import type { QueuedMessages } from '../../agent/session'
import { MessageQueue } from '../../interjection/message-queue'
import { PromptQueue, queueRows } from '../prompt-queue'

/*
 * 队列条的按号操作（R-01 §5.3）。
 *
 * 屏幕上那两枚键改的必须是**它们所在的那一行**：早先 UI 只把正文摊成字符串数组、
 * 撤回靠「猜队首」，于是画在最后一行、撤掉的却是第一条（R-01 §1 缺陷 D）。
 * 这里钉两件事：换层按最后一行自己的 id 掉 `queue.move`（不是撤回再重投），
 * 以及撤回拿回的就是那一行自己的正文。
 */

function queued(over: Partial<QueuedMessages> = {}): QueuedMessages {
  return {
    threadId: 't1',
    steering: [],
    followUp: [],
    steeringMode: 'all',
    followUpMode: 'all',
    interruptMode: 'immediate',
    ...over,
  }
}

interface Recorded {
  readonly moved: { itemId: string; deliverAs: string }[]
  readonly withdrawn: string[]
}

function queueOf(snapshot: QueuedMessages): { queue: MessageQueue; recorded: Recorded } {
  const recorded: Recorded = { moved: [], withdrawn: [] }
  const queue = new MessageQueue({
    withdraw: async (itemId) => {
      recorded.withdrawn.push(itemId)
      return { text: itemId }
    },
    move: async (itemId, deliverAs) => {
      recorded.moved.push({ itemId, deliverAs })
      return snapshot
    },
    setModes: async () => snapshot,
    failed: () => undefined,
  })
  queue.accept(snapshot)
  return { queue, recorded }
}

describe('队列条（R-01 §5.3）', () => {
  test('换层按最后一行自己的 id 掉 queue.move，不碰 onEdit', async () => {
    const snapshot = queued({
      steering: [{ id: 's1', text: '插话的一句' }],
      followUp: [{ id: 'f2', text: '排队的一句' }],
    })
    const { queue, recorded } = queueOf(snapshot)
    const edits: string[] = []

    const { container } = render(<PromptQueue onEdit={(text) => edits.push(text)} queue={queue} />)
    const switches = container.querySelectorAll('[aria-label="插话：插进正在跑的这一轮"]')
    await act(async () => {
      fireEvent.click(switches[switches.length - 1]!)
    })

    expect(recorded.moved).toEqual([{ itemId: 'f2', deliverAs: 'steer' }])
    expect(recorded.withdrawn).toEqual([])
    expect(edits).toEqual([])
    cleanup()
  })

  test('撤回拿回的是按钮所在那一行的正文', async () => {
    const snapshot = queued({
      steering: [{ id: 's1', text: '插话的一句' }],
      followUp: [{ id: 'f2', text: '排队的一句' }],
    })
    const { queue, recorded } = queueOf(snapshot)
    const edits: string[] = []

    const { container } = render(<PromptQueue onEdit={(text) => edits.push(text)} queue={queue} />)
    await act(async () => {
      fireEvent.click(container.querySelector('[aria-label="撤回最后一条，正文回输入框"]')!)
    })

    expect(recorded.withdrawn).toEqual(['f2'])
    // 端口交回的正文按 id 造，落进输入框的就是最后一条的正文
    expect(edits).toEqual(['f2'])
    cleanup()
  })

  test('queueRows 保留 id：两层接着数，最后一行才是两枚控件的那一条', () => {
    const rows = queueRows(queued({ steering: [{ id: 's1', text: 'A' }], followUp: [{ id: 'f1', text: 'B' }] }))
    expect(rows.map((row) => ({ id: row.id, ordinal: row.ordinal, last: row.last }))).toEqual([
      { id: 's1', ordinal: 1, last: false },
      { id: 'f1', ordinal: 2, last: true },
    ])
  })
})
