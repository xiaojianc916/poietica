import { describe, expect, test } from 'bun:test'
import { applyOps, emptyTimeline, pageFromState, type TranscriptOperation } from '@poietica/transcript'
import { wireTextOf } from '../../session/prompt'
import { projectHistoryPage } from '../history'
import { FILE_MEDIA_TYPE } from '../live'
import { assistant, T0 } from './fixtures/history'
import { projector } from './fixtures/live'

/*
 * 普通文件（输入框里的文件记号、元素拾取的报告）也要画在用户气泡上，而且重开之后还在。
 *
 * 文件没有像素：条目只有名字。增量那条路名字从提交里来；重开那条路名字从会话文件里那句投递正文读回来
 * （`wireTextOf` 把名字写在每一行引用后面），气泡上画的是用户原文，不是那几行引用。
 */
const FILES = [
  { path: 'C:\\poietica\\attachments\\ab\\abc', name: 'poietica-tool-grouping.patch' },
  { path: 'C:\\poietica\\attachments\\cd\\cde', name: 'div.md' },
]

function sent(text: string, at: number) {
  return { role: 'user', timestamp: T0 + at, content: wireTextOf({ text, files: FILES }) }
}

function turnOf(ops: readonly TranscriptOperation[]) {
  const op = ops.find((entry) => entry.op === 'turn.upsert')
  return op?.op === 'turn.upsert' ? op.turn : undefined
}

describe('历史分页：文件从投递正文读回来', () => {
  test('轮头的 prompt 是原文，文件条目带名字、号挂在轮头上', () => {
    const page = projectHistoryPage([sent('你可以看见吗', 0), assistant('看到了', 10)], null)
    const turn = page.items.find((item) => item.kind === 'turn')

    expect(turn?.kind === 'turn' ? turn.prompt : undefined).toBe('你可以看见吗')
    expect(page.attachments.map(({ mediaType, name }) => ({ mediaType, name }))).toEqual([
      { mediaType: FILE_MEDIA_TYPE, name: 'poietica-tool-grouping.patch' },
      { mediaType: FILE_MEDIA_TYPE, name: 'div.md' },
    ])
    expect(turn?.kind === 'turn' ? turn.attachmentIds : undefined).toEqual(
      page.attachments.map((attachment) => attachment.attachmentId),
    )
  })

  test('只发了文件（原文为空）：轮头 prompt 是空串，文件照样在', () => {
    const page = projectHistoryPage([sent('', 0), assistant('收到', 10)], null)
    const turn = page.items.find((item) => item.kind === 'turn')

    expect(turn?.kind === 'turn' ? turn.prompt : undefined).toBe('')
    expect(page.attachments).toHaveLength(2)
  })

  test('两句各带文件：号不撞，各挂各的', () => {
    const page = projectHistoryPage(
      [sent('第一句', 0), assistant('一', 10), sent('第二句', 20), assistant('二', 30)],
      null,
    )
    const ids = page.attachments.map((attachment) => attachment.attachmentId)

    expect(new Set(ids).size).toBe(4)
  })

  test('插话带的文件挂在插话帧上，帧上的正文是原文', () => {
    const page = projectHistoryPage(
      [
        { role: 'user', timestamp: T0, content: '先做' },
        { ...assistant('在做', 10), completedAt: T0 + 50 },
        sent('顺便看这个', 20),
        assistant('好', 60),
      ],
      null,
    )
    const frames = page.items.flatMap((item) => (item.kind === 'turn' ? item.steps.flatMap((step) => step.frames) : []))
    const said = frames.find((frame) => frame.kind === 'text' && frame.role === 'user')

    expect(said?.kind === 'text' ? said.text : undefined).toBe('顺便看这个')
    expect(said?.kind === 'text' ? said.attachmentIds?.length : undefined).toBe(2)
  })
})

describe('LiveProjector：文件条目', () => {
  test('userTurn 带 files：条目只有名字，轮头挂号；openTurnAttachments 只留图', () => {
    const p = projector()
    const ops = p.userTurn({ text: '看看', files: [{ attachmentId: 'f#0', name: 'div.md' }] })
    const page = pageFromState(applyOps(emptyTimeline(), ops))

    expect(page.attachments).toEqual([{ attachmentId: 'f#0', mediaType: FILE_MEDIA_TYPE, name: 'div.md' }])
    expect(turnOf(ops)?.attachmentIds).toEqual(['f#0'])
    expect(p.openTurnAttachments).toEqual([])
  })

  test('插话带文件：条目先到，插话帧挂上号', () => {
    const p = projector()
    p.userTurn({ text: 'q' })
    const ops = p.steeredFrame('再看这个', [], [{ attachmentId: 's#f0', name: 'a.md' }])
    const frame = ops.find((op) => op.op === 'frame.upsert')

    expect(ops[0]?.op).toBe('attachment.upsert')
    expect(frame?.op === 'frame.upsert' && frame.frame.kind === 'text' ? frame.frame.attachmentIds : undefined).toEqual(
      ['s#f0'],
    )
  })
})
