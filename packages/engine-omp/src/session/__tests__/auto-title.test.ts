import { describe, expect, test } from 'bun:test'
import type { EngineSessionEvent } from '@poietica/engine'
import { fakeOmpSession } from '../../projector/__tests__/fixtures/omp-session'

/*
 * 自动总结标题的端口语义（omp 知识 #17）：omp 写完名字 → 适配器发一条 `sessionTitle`。
 *
 * 夹具（fakeOmpSession）照 omp 的真实顺序：先把名字写进 SessionManager，再通知
 * `onSessionNameChanged`（**回调不带名字**）—— 所以这条用例同时证明了「必须自己读 getSessionName」。
 */
const SUBMIT = { text: '帮我修一下登录页的样式', images: [], files: [], skills: [], deliverAs: 'turn' } as const

type TitleEvent = Extract<EngineSessionEvent, { type: 'sessionTitle' }>

function titleEvents(events: readonly EngineSessionEvent[]): TitleEvent[] {
  return events.filter((e): e is TitleEvent => e.type === 'sessionTitle')
}

describe('自动总结标题的端口语义（omp 知识 #17）', () => {
  test('T-AT-1 会话名落地 → 一条 sessionTitle 事件，且带上会话文件', async () => {
    const fake = await fakeOmpSession()
    await fake.session.submit(SUBMIT)
    fake.setSessionName('登录页样式修复')

    const events = titleEvents(fake.events)
    expect(events.length).toBe(1)
    expect(events[0]?.title).toBe('登录页样式修复')
    /* 带 sessionFile：Core 靠它认「这是哪条会话的名」，迟到的事件不许改现在的标题 */
    expect(events[0]?.sessionFile).toBe('session-1.jsonl')
  })

  test('T-AT-2 只在首条真轮代 omp 触发一次自动总结；第二条不再触发', async () => {
    /* 产品语义：标题要么由第一句话总结出来，要么留在首句兜底上，之后不再补问 */
    const fake = await fakeOmpSession()
    await fake.session.submit(SUBMIT)
    expect(fake.titleRequests).toEqual([SUBMIT.text])

    /* 等第一条跑完再发第二条（真机上「下一条消息」就是这条时序） */
    await fake.session.cancel()
    await fake.session.submit({ ...SUBMIT, text: '第二条：帮我修一下标题' })
    expect(fake.titleRequests).toEqual([SUBMIT.text])
  })

  test('T-AT-3 打开一条已经有名字的会话（订阅晚于打开）：第一个订阅者拿到补发的那一次', async () => {
    /* deferSubscribe：模拟会话池的顺序 —— openSession 返回后才订阅 */
    const fake = await fakeOmpSession({ spec: {}, deferSubscribe: true })
    fake.setSessionName('早就起好的名字')
    /* 还没订阅，事件不该丢：emitSessionTitle 在无订阅者时先存着 */
    expect(titleEvents(fake.events)).toEqual([])

    fake.listen()
    expect(titleEvents(fake.events).map((e) => e.title)).toEqual(['早就起好的名字'])
  })

  test('T-AT-4 autoTitle=false 的会话：一次都不触发（用户定过名的线程）', async () => {
    const fake = await fakeOmpSession({ spec: { autoTitle: false } })
    await fake.session.submit(SUBMIT)
    expect(fake.titleRequests).toEqual([])
  })
})
