import { describe, expect, test } from 'bun:test'
import type { EngineSessionEvent } from '@poietica/engine'
import type { TranscriptOperation } from '@poietica/transcript'
import { applyOps, emptyTimeline } from '@poietica/transcript'
import { fakeOmpSession } from './fixtures/omp-session'

/*
 * 插话的三层投递与「认领」（legacy interjection-layers.test.ts，12 页 §12.3）。
 *
 * legacy 的缺口是一整条：deliverAs 之前根本不存在，而唯一那条 steer 命令把 prompt 号当正文
 * 发进插话队列，三层里一层都没真的用上。新树的三层路由在 OmpSession.submit / enqueue /
 * omp-session-adapter 的 steer 上，这里按 legacy 的判据逐条钉：
 *
 *   1. 运行中的 steer / followUp 落在 omp 自己的队列（session.steer / followUp）；
 *   2. 空闲时的 steer / followUp 按 turn 处理（语义就是开始一轮）；
 *   3. 轮终之后折进上下文的那一句**认得出来**（claimInjection 画成一句人话）；
 *   4. 认不出来的话（撤回过的、没投过的）宁可少画一条，也不把开场白错认成插话；
 *   5. 取消之后仍然认得出 —— 上游 abort 刻意不动 steering 队列（agent-loop.ts:1637-1643），
 *      取消这一刻把它从账本里摘掉，就等于那句人已经写好的话再也画不出来。
 *
 * 被测对象是 OmpSession 自己：假的 omp 会话只实现适配器用到的那几格（fixtures/omp-session.ts），
 * 副作用的判据是「哪一个方法被调了、正文是什么」＋「时间线上多没多出那一句」。
 * legacy 的文件级夹具（queued / withdrawn / modes 三个死对象）换成按用例现搭。
 */
const NOW = 1_700_000_000_000

function submit(text: string, deliverAs: 'turn' | 'steer' | 'followUp') {
  return { text, images: [], files: [], skills: [], deliverAs }
}

function timelineTexts(events: readonly EngineSessionEvent[]): string[] {
  const ops = events.flatMap((event) => (event.type === 'timeline' ? event.ops : []))
  const state = applyOps(emptyTimeline(), ops)
  const texts: string[] = []
  for (const item of state.items) {
    if (item.kind !== 'turn') continue
    for (const step of item.steps)
      for (const frame of step.frames) {
        if (frame.kind === 'text') texts.push(frame.text)
      }
  }
  return texts
}

function steeringFrameRoles(events: readonly EngineSessionEvent[]): string[] {
  const ops: TranscriptOperation[] = events.flatMap((event) => (event.type === 'timeline' ? event.ops : []))
  const state = applyOps(emptyTimeline(), ops)
  const roles: string[] = []
  for (const item of state.items) {
    if (item.kind !== 'turn') continue
    for (const step of item.steps)
      for (const frame of step.frames) {
        if (frame.kind === 'text') roles.push(frame.role)
      }
  }
  return roles
}

describe('插话的三层投递（legacy interjection-layers.test.ts）', () => {
  test('空闲时的 steer 落成一轮，不是进队列', async () => {
    const fake = await fakeOmpSession()
    await fake.session.submit(submit('一句话', 'steer'))
    // 空闲时点「插话」的语义就是开始一轮
    expect(fake.calls.map((call) => call.how)).toEqual(['prompt'])
    expect(fake.session.state()).toBe('running')
  })

  test('运行中的 steer 落进 omp 的 steering 队列', async () => {
    const fake = await fakeOmpSession()
    fake.feed({ type: 'agent_end' })
    await fake.session.submit(submit('打底的一轮', 'turn'))
    fake.calls.length = 0

    await fake.session.submit(submit('一句steer', 'steer'))
    expect(fake.calls.map((call) => call.how)).toEqual(['steer'])
    expect(fake.calls[0]?.text).toBe('一句steer')
  })

  test('运行中的 followUp 落进 follow-up 队列，不是 turn', async () => {
    const fake = await fakeOmpSession()
    await fake.session.submit(submit('打底的一轮', 'turn'))
    fake.calls.length = 0

    await fake.session.submit(submit('一句followUp', 'followUp'))
    expect(fake.calls.map((call) => call.how)).toEqual(['followUp'])
  })

  test('挂技能的插话走自定义消息那条路，正文带上原文', async () => {
    const fake = await fakeOmpSession({ skills: [{ name: 'review' }] })
    await fake.session.submit(submit('打底的一轮', 'turn'))
    fake.calls.length = 0

    await fake.session.submit({ ...submit('带技能的一句', 'steer'), skills: ['review'] })
    expect(fake.calls.map((call) => call.how)).toEqual(['customMessage'])
  })

  /*
   * 技能必须走 omp 官方的展开路径（12 页 §7.6）：投出去的是 SKILL.md 的正文，
   * 而不是「review」这三个字。只送名字等于技能静默不跑 —— 模型会当普通一句话处理。
   */
  test('技能投出去的是 SKILL.md 的正文，不是技能名', async () => {
    const fake = await fakeOmpSession({ skills: [{ name: 'review' }] })
    await fake.session.submit({ ...submit('打底', 'turn'), skills: ['review'] })
    // 技能展开要读 SKILL.md：投递与这一句之间隔着一个 await，等一拍再断言
    await Bun.sleep(20)

    const sent = (fake.calls.find((call) => call.how === 'customMessage')?.text ?? '') as string
    expect(sent).toContain('夹具技能的正文。')
    // 官方的用户模板会带上技能名，但不等于「只发了名字」
    expect(sent).toContain('review')
    expect(sent).not.toBe('review')
  })
})

describe('折进上下文的插话会被认领（legacy interjection-layers.test.ts）', () => {
  test('轮终之后仍然认得出，画成一句人话而不是消失', async () => {
    const fake = await fakeOmpSession()
    await fake.session.submit(submit('打底', 'turn'))
    await fake.session.submit(submit('一句followUp', 'followUp'))

    // 轮终：omp 把这句话折进上下文，发一条 message_start（正文就是投出去的那一句）
    fake.feed({
      type: 'message_start',
      message: { role: 'user', content: '一句followUp', timestamp: NOW + 1 },
    })

    const texts = timelineTexts(fake.events)
    expect(texts).toContain('一句followUp')
    // 人说的话必须带 origin：屏幕认「这是人说的」只看那一格
    expect(steeringFrameRoles(fake.events)).toContain('user')
  })

  test('认不出来的开场白不会被错认成插话', async () => {
    const fake = await fakeOmpSession()
    await fake.session.submit(submit('打底', 'turn'))
    // 这一句从来没投出去过（撤回掉的、或别人塞进来的开场白），轮终也不该认
    fake.feed({ type: 'message_start', message: { role: 'user', content: '一句steer', timestamp: NOW + 1 } })

    expect(timelineTexts(fake.events)).not.toContain('一句steer')
  })

  test('取消不排空队列：取消之后仍然认得出那一句', async () => {
    const fake = await fakeOmpSession()
    await fake.session.submit(submit('打底', 'turn'))
    await fake.session.submit(submit('一句steer', 'steer'))
    await fake.session.cancel()

    fake.feed({ type: 'message_start', message: { role: 'user', content: '一句steer', timestamp: NOW + 1 } })
    // post-abort 的 continue 把它折进上下文：认得出来，画得出来
    expect(timelineTexts(fake.events)).toContain('一句steer')
  })

  test('同一句话认领一次就出账：第二条 message_start 不再画一遍', async () => {
    const fake = await fakeOmpSession()
    await fake.session.submit(submit('打底', 'turn'))
    await fake.session.submit(submit('一句steer', 'steer'))
    fake.feed({ type: 'message_start', message: { role: 'user', content: '一句steer', timestamp: NOW + 1 } })
    fake.feed({ type: 'message_start', message: { role: 'user', content: '一句steer', timestamp: NOW + 2 } })
    expect(timelineTexts(fake.events).filter((text) => text === '一句steer')).toHaveLength(1)
  })

  test('工具结果与助手消息的发帧不会误认成插话', async () => {
    const fake = await fakeOmpSession()
    await fake.session.submit(submit('打底', 'turn'))
    await fake.session.submit(submit('一句steer', 'steer'))
    fake.feed({ type: 'message_start', message: { role: 'assistant', content: '一句steer', timestamp: NOW + 1 } })
    expect(timelineTexts(fake.events)).not.toContain('一句steer')
  })
})
