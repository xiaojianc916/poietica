import { describe, expect, test } from 'bun:test'
import type { SideTopic, SideTurn } from '@poietica/engine'
import { createSideStore, fresherTopic, runningTopicOf, type SideApi, selectedTopicOf } from '../side-store'

/*
 * 辅助对话的账：数据只来自 Core（side.list / side.topic / side.delta），本地不造话题。
 * 这里用一个手搓的 api 替身，只验 store 自己的规矩：合并、拼接、对不上就重读、失败写进 error。
 */
const turn = (patch: Partial<SideTurn> = {}): SideTurn => ({
  question: '问',
  answer: '',
  status: 'running',
  createdAt: 1,
  updatedAt: 1,
  error: null,
  ...patch,
})
const topic = (id: string, turns: SideTurn[], leafId: string | null = null): SideTopic => ({ id, leafId, turns })

function fakeApi(overrides: Partial<SideApi> = {}) {
  const calls = {
    list: 0,
    ask: [] as Array<{ question: string; topicId: string | null }>,
    cancel: [] as Array<string | null>,
  }
  let listed: readonly SideTopic[] = []
  const api: SideApi = {
    listSide: async () => {
      calls.list += 1
      return listed
    },
    askSide: async (_threadId, question, topicId) => {
      calls.ask.push({ question, topicId })
      return topic(topicId ?? 'new', [turn({ question })])
    },
    cancelSide: async (_threadId, topicId) => {
      calls.cancel.push(topicId)
      return true
    },
    ...overrides,
  }
  return {
    api,
    calls,
    setListed: (next: readonly SideTopic[]) => {
      listed = next
    },
  }
}

describe('辅助对话 store', () => {
  test('load：读一次话题表，新开的在前；进行中的读共用一份', async () => {
    const { api, calls, setListed } = fakeApi()
    setListed([
      topic('old', [turn({ status: 'complete', createdAt: 1 })]),
      topic('new', [turn({ status: 'complete', createdAt: 5 })]),
    ])
    const side = createSideStore(api)
    await Promise.all([side.load('t1'), side.load('t1')])
    expect(calls.list).toBe(1)
    expect(side.of('t1').loaded).toBe(true)
    expect(side.of('t1').topics.map((t) => t.id)).toEqual(['new', 'old'])
  })

  test('ask：开问成功就选中那个话题；之后的追问默认接在它后面', async () => {
    const { api, calls } = fakeApi()
    const side = createSideStore(api)
    expect(await side.ask('t1', '第一问')).toBe(true)
    expect(calls.ask[0]).toEqual({ question: '第一问', topicId: null })
    expect(side.of('t1').selected).toBe('new')
    expect(runningTopicOf(side.of('t1'))?.id).toBe('new')
    expect(selectedTopicOf(side.of('t1'))?.turns[0]?.question).toBe('第一问')
    /* 还在答：store 自己挡住第二问，不去撞 Core 的 engine.side_busy */
    expect(await side.ask('t1', '第二问')).toBe(false)
    expect(calls.ask).toHaveLength(1)
    /* 答完之后再问：接在选中的话题后面；显式给 null 才开新话题 */
    side.applyTopic('t1', topic('new', [turn({ question: '第一问', status: 'complete', updatedAt: 2 })]))
    expect(await side.ask('t1', '追问')).toBe(true)
    expect(calls.ask[1]).toEqual({ question: '追问', topicId: 'new' })
  })

  test('ask 失败：写进 error、返回 false，不选中任何话题', async () => {
    const { api } = fakeApi({
      askSide: async () => {
        throw new Error('这条对话还没有可用的模型')
      },
    })
    const side = createSideStore(api)
    expect(await side.ask('t1', '问')).toBe(false)
    expect(side.of('t1').error).toBe('这条对话还没有可用的模型')
    expect(side.of('t1').asking).toBe(false)
    expect(side.of('t1').selected).toBeNull()
    side.dismiss('t1')
    expect(side.of('t1').error).toBeNull()
  })

  test('delta：按 offset 首尾相接；重复的一截不重拼；对不上就重读', async () => {
    const { api, calls, setListed } = fakeApi()
    const side = createSideStore(api)
    side.applyTopic('t1', topic('a', [turn()]))
    side.applyDelta('t1', { topicId: 'a', turn: 0, offset: 0, delta: '你好' })
    side.applyDelta('t1', { topicId: 'a', turn: 0, offset: 2, delta: '世界' })
    expect(side.of('t1').topics[0]?.turns[0]?.answer).toBe('你好世界')
    /* 重读的应答里已经带着这一截（应答与推送交错） */
    side.applyDelta('t1', { topicId: 'a', turn: 0, offset: 2, delta: '世界' })
    expect(side.of('t1').topics[0]?.turns[0]?.answer).toBe('你好世界')
    expect(calls.list).toBe(0)

    /* 漏了一截：不硬拼，重读 */
    setListed([topic('a', [turn({ answer: '你好世界！完整', updatedAt: 2 })])])
    side.applyDelta('t1', { topicId: 'a', turn: 0, offset: 7, delta: '尾巴' })
    expect(calls.list).toBe(1)
    await side.load('t1')
    expect(side.of('t1').topics[0]?.turns[0]?.answer).toBe('你好世界！完整')
  })

  test('合并：旧的读表应答盖不掉新的推送（收口的快照比还在答的新）', async () => {
    const { api, setListed } = fakeApi()
    const side = createSideStore(api)
    side.applyTopic('t1', topic('a', [turn({ status: 'complete', answer: '答完了', updatedAt: 3 })]))
    setListed([topic('a', [turn({ status: 'running', answer: '答', updatedAt: 2 })])])
    await side.load('t1')
    expect(side.of('t1').topics[0]?.turns[0]).toMatchObject({ status: 'complete', answer: '答完了' })

    const held = topic('b', [turn({ status: 'complete' })])
    const followUp = topic('b', [turn({ status: 'complete' }), turn({ question: '追问' })])
    expect(fresherTopic(held, followUp)).toBe(followUp)
    expect(fresherTopic(followUp, held)).toBe(followUp)
  })

  test('cancel：停正在答的那个话题；Core 说没有在答的就重读一次', async () => {
    const { api, calls, setListed } = fakeApi({
      cancelSide: async (_threadId, topicId) => {
        calls.cancel.push(topicId)
        return false
      },
    })
    const side = createSideStore(api)
    side.applyTopic('t1', topic('a', [turn()]))
    setListed([topic('a', [turn({ status: 'cancelled', updatedAt: 2 })])])
    await side.cancel('t1')
    expect(calls.cancel).toEqual(['a'])
    expect(calls.list).toBe(1)
    expect(runningTopicOf(side.of('t1'))).toBeUndefined()
  })

  test('notice 与 forget：提醒写进账里；对话删了以后迟到的推送不再把账写回来', () => {
    const { api } = fakeApi()
    const side = createSideStore(api)
    side.applyNotice('t1', '话题没能存盘')
    expect(side.of('t1').notice).toBe('话题没能存盘')
    side.forget('t1')
    side.applyTopic('t1', topic('a', [turn()]))
    side.applyDelta('t1', { topicId: 'a', turn: 0, offset: 0, delta: '迟到' })
    expect(side.store.getState().byThread.t1).toBeUndefined()
  })

  test('reloadLoaded：只重读读过的对话', async () => {
    const { api, calls } = fakeApi()
    const side = createSideStore(api)
    await side.load('t1')
    side.applyNotice('t2', '没读过表')
    side.reloadLoaded()
    await side.load('t1')
    expect(calls.list).toBe(2)
  })
})
