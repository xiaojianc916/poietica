import type { RunEvent } from '@poietica/agent-contract'
import { describe, expect, it } from 'vitest'
import { createIpcSession } from '../kap-session'

/* 原生侧交回来的那一种地址，原样照抄，不在这里重新拼一遍它的形状。 */
const DELIVERED = 'poietica-asset://asset/t/0000'

/*
 * 这一层只做转发。
 *
 * 帧的形状由原生侧的 RunFrame enum 保证，地址由信封给出（见 kap-session.ts
 * 开头的说明）。适配器不认识帧里的任何一格，所以这里用一个哨兵对象：要断言的
 * 是「原样交出去」，不是某一版协议长什么样。用 timeline 的真录像反而会给一个
 * 不需要它的包挂上一条依赖。
 */
describe('ipc session', () => {
  it('原样转发一批帧与它们的地址，不在客户端重新描述协议', () => {
    let emit: (payload: readonly unknown[], sessionId: string) => void = () => {}
    const frame = { kind: 'sentinel' } as unknown as RunEvent

    const session = createIpcSession({
      bridge: {
        prompt: () => Promise.resolve({ sessionId: 's', images: [] }),
        cancel: () => Promise.resolve(),
        resolvePermission: () => Promise.resolve(),
      },
      source: {
        listen: (handler) => {
          emit = handler
          return () => {}
        },
      },
    })

    const received: Array<[readonly RunEvent[], string]> = []
    session.subscribe((events, sessionId) => received.push([events, sessionId]))

    emit([frame], 'sess_1')

    expect(received).toHaveLength(1)
    expect(received.at(0)?.[0].at(0)).toBe(frame)
    expect(received.at(0)?.[1]).toBe('sess_1')
  })

  it('prompt 把原生侧给的会话号原样交回；图片改由 run_started 帧走', async () => {
    const session = createIpcSession({
      bridge: {
        /* 原生侧答复里就算带着地址，这一层也不再从 handle 走：地址随这一轮的
           run_started 帧回来（见 frame.rs 的 RunStarted），与那句话的文字同一条路。 */
        prompt: () => Promise.resolve({ sessionId: 'sess_2', images: [DELIVERED] }),
        cancel: () => Promise.resolve(),
        resolvePermission: () => Promise.resolve(),
      },
      source: { listen: () => () => {} },
    })

    await expect(session.prompt({ threadId: 't', text: 'hi', assets: [] })).resolves.toEqual({
      sessionId: 'sess_2',
    })
  })
})
