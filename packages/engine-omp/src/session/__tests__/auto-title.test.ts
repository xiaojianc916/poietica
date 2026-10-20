import { describe, expect, test } from 'bun:test'
import type { EngineSessionEvent } from '@poietica/engine'
import { fakeOmpSession } from '../../projector/__tests__/fixtures/omp-session'

/*
 * 自动总结标题的端口语义（omp 知识 #17）：omp 自己起名，适配器只把结果**报回来**。
 *
 * 宿主的职责只有两处，各有一条用例：
 *   1. 开会话时把 `autoTitle` 放进 createAgentSession（session-factory），由 `spec.autoTitle` 门禁 ——
 *      这条在 session-factory.test.ts 里用替身直接断言入参，不经过 omp；
 *   2. omp 写进会话名之后由 `onSessionNameChanged` 报回一条 `sessionTitle`（这里，用 fakeOmpSession）。
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

  test('T-AT-2 omp 之后再改名：每落一次报一次，第二条的标题同样跟上', async () => {
    /* omp 的重规划刷新（todo init 之后）会再改一次名；宿主不自己去猜，来一次报一次 */
    const fake = await fakeOmpSession()
    await fake.session.submit(SUBMIT)
    fake.setSessionName('登录页样式修复')
    fake.setSessionName('修复登录页样式与表单校验')

    expect(titleEvents(fake.events).map((e) => e.title)).toEqual(['登录页样式修复', '修复登录页样式与表单校验'])
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
})
