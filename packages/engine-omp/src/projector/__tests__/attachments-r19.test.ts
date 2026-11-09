import { describe, expect, test } from 'bun:test'
import {
  type AgentEvent,
  EMPTY_THREAD_STATE,
  materialize,
  reduceAll,
  snapshotOf,
  type ThreadState,
} from '@poietica/agent-model'
import { projectHistoryPage } from '../history'
import { assistant, T0 } from './fixtures/history'
import { projector } from './fixtures/live'

/*
 * 审查 R-19-1：图片要能在用户气泡上画出来，而且重开之后还在。
 *
 * 界面只按「轮头 / 人话帧上的 attachmentIds」去附件表里找图：条目发了、号没挂上，
 * 等于这张图从屏幕上消失（模型照样看得见 —— 像素已经交给 omp 了）。
 */
const IMAGE = { type: 'image', data: 'AAAA', mimeType: 'image/png' }

function withImage(text: string, at: number) {
  return { role: 'user', timestamp: T0 + at, content: [{ type: 'text', text }, IMAGE] }
}

describe('历史分页：轮头挂上图片的号', () => {
  test('带图的那一轮，轮头的 attachmentIds 与附件条目一一对应', () => {
    const page = projectHistoryPage([withImage('看图', 0), assistant('看到了', 10)], null)
    const turn = page.items.find((item) => item.kind === 'turn')
    expect(page.attachments).toHaveLength(1)
    expect(turn?.kind === 'turn' ? turn.attachmentIds : undefined).toEqual([page.attachments[0]!.attachmentId])
  })

  test('没带图的轮不挂 attachmentIds（不写空数组）', () => {
    const page = projectHistoryPage([{ role: 'user', timestamp: T0, content: '纯文字' }, assistant('好', 10)], null)
    const turn = page.items.find((item) => item.kind === 'turn')
    expect(turn !== undefined && 'attachmentIds' in turn).toBe(false)
  })

  test('还开着的那一轮沿用增量那条路的号：收尾时的轮头指向同一批条目', () => {
    const live = [
      { attachmentId: 'live#0', mediaType: 'image/png', source: { kind: 'blob', sha256: 'a'.repeat(64) } },
    ] as const
    const page = projectHistoryPage([withImage('看图', 0)], null, { isTurnOpen: true, openTurnAttachments: live })
    const turn = page.items.find((item) => item.kind === 'turn')
    expect(page.attachments.map((attachment) => attachment.attachmentId)).toEqual(['live#0'])
    expect(turn?.kind === 'turn' ? turn.attachmentIds : undefined).toEqual(['live#0'])
  })

  test('张数对不上（omp 的消息里还没有这一句）就不沿用：不把这一轮的图挂到上一轮头上', () => {
    const live = [
      { attachmentId: 'live#0', mediaType: 'image/png', source: { kind: 'blob', sha256: 'b'.repeat(64) } },
    ] as const
    const page = projectHistoryPage([{ role: 'user', timestamp: T0, content: '上一句' }, assistant('答', 10)], null, {
      isTurnOpen: true,
      openTurnAttachments: live,
    })
    expect(page.attachments).toEqual([])
  })

  test('已经收口的轮不受 openTurnAttachments 影响', () => {
    const live = [
      { attachmentId: 'live#0', mediaType: 'image/png', source: { kind: 'blob', sha256: 'b'.repeat(64) } },
    ] as const
    const page = projectHistoryPage([withImage('看图', 0), assistant('答', 10)], null, { openTurnAttachments: live })
    expect(page.attachments.map((attachment) => attachment.attachmentId)).not.toContain('live#0')
  })
})

describe('LiveProjector：插话与开轮带图', () => {
  const image = (id: string) => ({ attachmentId: id, mediaType: 'image/png', sha256: 'c'.repeat(64) })
  const fold = (events: readonly AgentEvent[]): ThreadState => reduceAll(EMPTY_THREAD_STATE, events)

  test('userTurn 带 images：先发条目、轮头挂号，开着时 openTurnAttachments 交得出这批条目', () => {
    const p = projector()
    const events = p.userTurn({ text: '看图', images: [image('a#0'), image('a#1')] })
    expect(events.slice(0, 2).map((event) => event.type)).toEqual(['attachment.added', 'attachment.added'])
    const turn = events.find((event) => event.type === 'run.started')
    expect(turn?.type === 'run.started' ? turn.run.attachmentIds : undefined).toEqual(['a#0', 'a#1'])
    expect(p.openTurnAttachments.map((attachment) => attachment.attachmentId)).toEqual(['a#0', 'a#1'])

    const end = p.turnEnd('completed', null)
    const closed = materialize(reduceAll(fold(events), end)).items[0]
    expect(closed?.kind === 'turn' ? closed.attachmentIds : undefined).toEqual(['a#0', 'a#1'])
    expect(p.openTurnAttachments).toEqual([])
  })

  test('开着一轮时插话带图：条目先到，插话帧挂上号', () => {
    const p = projector()
    p.userTurn({ text: 'q' })
    const events = p.steeredFrame('再看这张', [image('s#0')])
    expect(events[0]?.type).toBe('attachment.added')
    const frame = events.find((event) => event.type === 'item.started')
    expect(
      frame?.type === 'item.started' && frame.frame.kind === 'text' ? frame.frame.attachmentIds : undefined,
    ).toEqual(['s#0'])
    const page = snapshotOf(fold(events))
    expect(page.attachments.map((attachment) => attachment.attachmentId)).toEqual(['s#0'])
  })

  test('轮已收口时的插话退回成新一轮：图挂在轮头上', () => {
    const p = projector()
    p.userTurn({ text: 'q' })
    p.turnEnd('completed', null)
    const events = p.steeredFrame('下一句', [image('n#0')])
    const turn = events.find((event) => event.type === 'run.started')
    expect(turn?.type === 'run.started' ? turn.run.attachmentIds : undefined).toEqual(['n#0'])
  })
})
