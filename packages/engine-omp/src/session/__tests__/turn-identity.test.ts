import { describe, expect, test } from 'bun:test'
import type { SubmitInput } from '@poietica/engine'
import type { TranscriptOperation } from '@poietica/transcript'
import { OmpSession } from '../session'
import { hostOf } from './host-fixture'

/*
 * 轮号是跨进程身份：Core 侧把 clientTurnId 绑到引擎的 turnId 上并存库，冷读时按 turnId 盖回去。
 * 一轮**没写进会话文件**（提交失败 / 被拦截）却占了一个号的话，之后每一轮都比文件多 1 —— 冷读后提交行
 * 盖不上号（两个用户气泡）、分叉多截一轮、开轮屏找不到号就追加。
 */

const INPUT: SubmitInput = { text: '这是什么', images: [], files: [], skills: [], deliverAs: 'turn' }

const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve()
}

function opRecorder(session: OmpSession): TranscriptOperation[] {
  const ops: TranscriptOperation[] = []
  session.subscribe((event) => {
    if (event.type === 'timeline') ops.push(...event.ops)
  })
  return ops
}

describe('轮号与提交结果', () => {
  test('提交失败不占轮号：下一轮仍然是 t1，且失败收尾时会按会话文件重新落座', async () => {
    let fail = true
    let reseats = 0
    const base = hostOf({
      promptWithImages: async () => {
        if (fail) throw new Error('prompt rejected')
        return true
      },
    })
    /* 夹具里的会话文件是空的：真实适配器的 reseat 把号摆回文件里最后一轮的序号（这里就是 0）。 */
    const host = {
      ...base,
      reseat: (): void => {
        reseats += 1
        base.projector.seat(0)
      },
    }
    const session = new OmpSession(host, { sessionId: 's1', sessionFile: 'f1' })
    const ops = opRecorder(session)

    await session.submit(INPUT)
    await settle()
    expect(reseats).toBe(1)

    fail = false
    await session.submit(INPUT)
    await settle()

    /* 没有回摆的话第二次是 t2：文件里只有一轮，冷读时那个提交行永远盖不上号。
     * turnEnd 也会 upsert 同一个轮（收尾那一格），所以按去重后的 id 判。 */
    const ids = ops.filter((op) => op.op === 'turn.upsert').map((op) => op.turn.turnId)
    expect([...new Set(ids)]).toEqual(['t1'])
  })
})
