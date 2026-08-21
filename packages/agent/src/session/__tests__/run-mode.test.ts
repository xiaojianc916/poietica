import type { RunEvent } from '@poietica/agent-contract'
import { describe, expect, it } from 'vitest'
import { replayRunEvents } from '../../timeline'
import { composePrompt } from '../run-mode'

/*
 * 模式是旁白，不是人说的话。
 *
 * 送出去的那一段由 composePrompt 拼，屏幕上那一条由投影从同一段字里读回来 ——
 * 两者必须给出同一句话，否则重开一条对话就会看到自己没说过的话。
 */

const SAID = '把测试跑绿'

const started = (prompt: string): RunEvent => ({
  kind: 'run_started',
  seq: 1,
  at: 0,
  sessionId: 'session-1',
  prompt,
})

describe('composePrompt', () => {
  it('模式不上屏：重放出来的仍然只是人说的那句话', () => {
    const sent = composePrompt({ goal: '别改公共接口', swarm: true }, SAID)
    const [said] = replayRunEvents([started(sent)]).items

    expect(sent).toContain('<system-reminder>')
    expect(sent).toContain('别改公共接口')
    expect(said).toMatchObject({ type: 'user_message', text: SAID })
  })

  it('没有模式时送出去的就是那句话本身', () => {
    expect(composePrompt({ goal: null, swarm: false }, ` ${SAID} `)).toBe(SAID)
  })
})
