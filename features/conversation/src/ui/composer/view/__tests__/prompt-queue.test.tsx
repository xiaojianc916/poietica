import { describe, expect, test } from 'bun:test'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { MessageQueue } from '../../../shared/model/message-queue'
import type { QueuedAttachment, QueuedMessages, WithdrawnMessage } from '../../../shared/model/session'
import { PromptQueue, queueCaption, queueFiles, queueImages, queueRows } from '../prompt-queue'

/*
 * 队列条的按号操作（R-01 缺陷 D）：早先 UI 只把正文摊成字符串数组、撤回靠「猜队首」，于是画在最后一行、
 * 撤掉的却是第一条。这里钉两件事：换层按最后一行自己的 id 掉 `queue.move`（不是撤回再重投），撤回拿回那一行自己的正文。
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

const SHOT_URL = 'poietica-asset://attachment/abc?mime=image/png'
const SHOT: QueuedAttachment = { id: 'a1', name: 'shot.png', kind: 'image', previewUrl: SHOT_URL }
const SHOT2: QueuedAttachment = { ...SHOT, id: 'a2', name: 'shot-2.png' }
const NOTES: QueuedAttachment = { id: 'f1', name: 'notes.md', kind: 'file', previewUrl: null }

function queueOf(snapshot: QueuedMessages): { queue: MessageQueue; recorded: Recorded } {
  const recorded: Recorded = { moved: [], withdrawn: [] }
  const queue = new MessageQueue({
    withdraw: async (itemId) => {
      recorded.withdrawn.push(itemId)
      const item = [...snapshot.steering, ...snapshot.followUp].find((entry) => entry.id === itemId)
      return { text: itemId, attachments: item?.attachments ?? [] }
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
      steering: [{ id: 's1', text: '插话的一句', attachments: [] }],
      followUp: [{ id: 'f2', text: '排队的一句', attachments: [] }],
    })
    const { queue, recorded } = queueOf(snapshot)
    const edits: string[] = []

    const { container } = render(<PromptQueue onEdit={(restored) => edits.push(restored.text)} queue={queue} />)
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
      steering: [{ id: 's1', text: '插话的一句', attachments: [] }],
      followUp: [{ id: 'f2', text: '排队的一句', attachments: [] }],
    })
    const { queue, recorded } = queueOf(snapshot)
    const edits: string[] = []

    const { container } = render(<PromptQueue onEdit={(restored) => edits.push(restored.text)} queue={queue} />)
    await act(async () => {
      fireEvent.click(container.querySelector('[aria-label="撤回最后一条，正文回输入框"]')!)
    })

    expect(recorded.withdrawn).toEqual(['f2'])
    // 端口交回的正文按 id 造，所以落进输入框的就是这一行自己的正文
    expect(edits).toEqual(['f2'])
    cleanup()
  })

  test('queueRows 保留 id：两层接着数，最后一行才是两枚控件的那一条', () => {
    const rows = queueRows(
      queued({
        steering: [{ id: 's1', text: 'A', attachments: [] }],
        followUp: [{ id: 'f1', text: 'B', attachments: [] }],
      }),
    )
    expect(rows.map((row) => ({ id: row.id, ordinal: row.ordinal, last: row.last }))).toEqual([
      { id: 's1', ordinal: 1, last: false },
      { id: 'f1', ordinal: 2, last: true },
    ])
  })
})

/*
 * 排队那一句带的图（截图里的缺陷：插话带了一张图，队列条上只剩正文）：行里画一张缩略图，
 * 高度吃在行的内边距里（--cp-queue-thumb），带图的行与不带图的行同一个类、同一档行高；撤回时图跟着正文一起回输入框。
 */
describe('队列条的图片预览', () => {
  test('queueImages 只收有预览地址的图，文件与还没地址的图不画', () => {
    const pending: QueuedAttachment = { ...SHOT, id: 'a3', previewUrl: null }
    expect(queueImages([SHOT, NOTES, pending]).map((image) => image.src)).toEqual([SHOT_URL])
  })

  test('带图的那一行画第一张缩略图，多张记 +N；不带图的行没有缩略图', () => {
    const snapshot = queued({
      steering: [{ id: 's1', text: '快点啊', attachments: [SHOT, SHOT2] }],
      followUp: [{ id: 'f2', text: '纯文字', attachments: [] }],
    })
    const { queue } = queueOf(snapshot)

    const { container } = render(<PromptQueue onEdit={() => undefined} queue={queue} />)
    const rows = container.querySelectorAll('.prompt-queue__row')
    const thumb = rows[0]!.querySelector<HTMLImageElement>('.prompt-queue__thumb img')

    expect(thumb?.getAttribute('src')).toBe(SHOT_URL)
    expect(rows[0]!.querySelector('.prompt-queue__thumb-more')?.textContent).toBe('+1')
    expect(rows[1]!.querySelector('.prompt-queue__thumb')).toBeNull()
    /* 缩略图在序号与正文之间：正文左缘跟着让，但仍是同一种行 */
    expect([...rows[0]!.children].map((child) => child.className)).toEqual([
      'prompt-queue__ordinal',
      'prompt-queue__thumb',
      'prompt-queue__said',
    ])
    cleanup()
  })

  test('只有一行时缩略图同样画在那一行里，图读不出来退成图片记号', () => {
    const snapshot = queued({ steering: [{ id: 's1', text: '快点啊', attachments: [SHOT] }] })
    const { queue } = queueOf(snapshot)

    const { container } = render(<PromptQueue onEdit={() => undefined} queue={queue} />)
    const image = container.querySelector<HTMLImageElement>('.prompt-queue__thumb img')!
    fireEvent.error(image)

    expect(container.querySelector('.prompt-queue__thumb img')).toBeNull()
    expect(container.querySelector('.prompt-queue__thumb-mark')).not.toBeNull()
    cleanup()
  })

  test('撤回时附件跟着正文一起交给 onEdit', async () => {
    const snapshot = queued({ steering: [{ id: 's1', text: '快点啊', attachments: [SHOT, NOTES] }] })
    const { queue } = queueOf(snapshot)
    const edits: WithdrawnMessage[] = []

    const { container } = render(<PromptQueue onEdit={(restored) => edits.push(restored)} queue={queue} />)
    await act(async () => {
      fireEvent.click(container.querySelector('[aria-label="撤回最后一条，正文回输入框"]')!)
    })

    expect(edits).toEqual([{ text: 's1', attachments: [SHOT, NOTES] }])
    cleanup()
  })
})

/*
 * 插话不带图以外的附件、只发图时那一行是空白：文件在队列条上隐身，纯图那一行读成「丢了内容」。
 * 这里钉：文件画成一枚记号（第一个名字 + N），正文为空时正文位换成弱化的附件摘要。
 */
describe('队列条的文件与纯附件行', () => {
  test('queueFiles 只收文件；queueCaption 有正文时为 null，没正文时数附件', () => {
    const pending: QueuedAttachment = { ...SHOT, id: 'a3', previewUrl: null }
    expect(queueFiles([SHOT, NOTES])).toEqual(['notes.md'])
    expect(queueCaption('快点啊', [SHOT])).toBeNull()
    expect(queueCaption('', [SHOT, pending])).toBe('2 张图片')
    expect(queueCaption('  ', [NOTES])).toBe('1 个文件')
    expect(queueCaption('', [SHOT, NOTES])).toBe('1 张图片、1 个文件')
  })

  test('带文件的行画文件记号，多个记 +N；纯图那一行的正文位是弱化摘要', () => {
    const NOTES2: QueuedAttachment = { ...NOTES, id: 'f2', name: 'plan.md' }
    const snapshot = queued({
      steering: [{ id: 's1', text: '', attachments: [SHOT] }],
      followUp: [{ id: 'f2', text: '看看这两个', attachments: [NOTES, NOTES2] }],
    })
    const { queue } = queueOf(snapshot)

    const { container } = render(<PromptQueue onEdit={() => undefined} queue={queue} />)
    const rows = container.querySelectorAll('.prompt-queue__row')

    expect(rows[0]!.querySelector('.prompt-queue__thumb img')?.getAttribute('src')).toBe(SHOT_URL)
    expect(rows[0]!.querySelector('.prompt-queue__said--caption')?.textContent).toBe('1 张图片')
    expect(rows[0]!.querySelector('.prompt-queue__file')).toBeNull()

    const file = rows[1]!.querySelector('.prompt-queue__file')!
    expect(file.querySelector('.prompt-queue__file-name')?.textContent).toBe('notes.md')
    expect(file.querySelector('.prompt-queue__file-more')?.textContent).toBe('+1')
    expect(file.getAttribute('title')).toBe('notes.md\nplan.md')
    expect(rows[1]!.querySelector('.prompt-queue__said')?.textContent).toBe('看看这两个')
    expect(rows[1]!.querySelector('.prompt-queue__said--caption')).toBeNull()
    cleanup()
  })
})
