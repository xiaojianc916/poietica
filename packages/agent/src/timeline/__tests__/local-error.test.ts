import type { RunEvent } from '@poietica/agent-contract'
import { describe, expect, it } from 'vitest'
import {
  appendLocalError,
  appendUserMessage,
  applyRunEvent,
  createTimelineState,
} from '../timeline-reducer'

const chunk = (seq: number, text: string): RunEvent => ({
  kind: 'kap_event',
  seq,
  at: seq,
  payload: { type: 'assistant.delta', delta: text },
})

describe('a local failure is not a frame', () => {
  it('takes no sequence number, so the real frame still lands', () => {
    const opened = applyRunEvent(createTimelineState(), chunk(1, '在'))
    const noted = appendLocalError(opened, { message: '答复没送出去。', at: 5, endsTurn: false })

    /* 状态里没有第二本序号账，lastSeq 就是那道窗口。此前这里还比对过一个早已
       不存在的 appliedSeqs —— 两边都是 undefined，这条断言从来没测到东西。 */
    expect(noted.lastSeq).toBe(opened.lastSeq)

    /* 伪造一帧、序号取当前的下一个时，被永久丢掉的正是紧接着到达的这一帧 ——
       它可能是一段文字，也可能是 run_finished。 */
    const answered = applyRunEvent(noted, chunk(2, '这里'))

    expect(answered.items.at(-1)).toMatchObject({ type: 'agent_text', text: '这里' })
  })

  it('only declares the turn failed when it ended it', () => {
    const asked = appendUserMessage(createTimelineState(), '在吗', 1)
    const running = applyRunEvent(asked, chunk(1, '在'))

    const aside = appendLocalError(running, { message: 'x', at: 5, endsTurn: false })
    const fatal = appendLocalError(running, { message: 'x', at: 5, endsTurn: true })

    expect(aside.status).toBe('running')
    expect(fatal.status).toBe('failed')
  })
})
