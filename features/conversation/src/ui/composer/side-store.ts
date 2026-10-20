import { latestSideTurn, type SideTopic } from '@poietica/engine'
import { createFeatureStore, type FeatureStore } from '@poietica/ui-kernel'
import type { ConversationApi } from '../api'

/**
 * 右坞「辅助对话」的账（按对话分账）：话题表、正在看哪个话题、正在开问、最近一次失败与引擎的提醒。
 *
 * 数据只有 Core 一个来源（side.list / side.topic / side.delta）：本地不造话题、不猜状态。
 * - side.topic 是整份快照：收到就整份替换那一个话题；
 * - side.delta 只接在正在答的那一问后面：本地长度对不上 offset 就是漏了一截 —— 重读 side.list，不硬拼；
 * - 重读与推送交错时按「谁更新」逐个话题合并（{@link fresherTopic}），不拿旧的应答盖掉新的推送。
 */
export interface SideThread {
  /** 新开的在前 */
  readonly topics: readonly SideTopic[]
  /** 读过一次 side.list（读失败也算读过：原因在 error） */
  readonly loaded: boolean
  /** 正在看、下一问接着追问的话题；null = 下一问开新话题 */
  readonly selected: string | null
  /** side.ask 已经发出、快照还没回来 */
  readonly asking: boolean
  /** 最近一次失败（发问 / 停止 / 读表）；下一次发问或人关掉时清掉 */
  readonly error: string | null
  /** 引擎的提醒（话题没能存盘之类）；人关掉或下一问清掉 */
  readonly notice: string | null
}

export const EMPTY_SIDE_THREAD: SideThread = {
  topics: [],
  loaded: false,
  selected: null,
  asking: false,
  error: null,
  notice: null,
}

export interface SideState {
  readonly byThread: Readonly<Record<string, SideThread>>
}

export type SideApi = Pick<ConversationApi, 'askSide' | 'cancelSide' | 'listSide'>

export interface SideDelta {
  readonly topicId: string
  readonly turn: number
  readonly offset: number
  readonly delta: string
}

export interface SideStore {
  readonly store: FeatureStore<SideState>
  of(threadId: string): SideThread
  /** 读一次话题表（同一条对话进行中的读共用一份）；从不抛：失败写进 error */
  load(threadId: string): Promise<void>
  /** 重读已经读过的那些对话（Core 重启之后：手里的快照可能已经过时，正在答的那一问也已经停了） */
  reloadLoaded(): void
  /**
   * 问一句：`topicId` 缺省 = 接着正在看的话题问（没有就开新话题），null = 开新话题。
   * 成功就选中那个话题并返回 true；失败写进 error 并返回 false（调用方据此把草稿放回去）。
   */
  ask(threadId: string, question: string, topicId?: string | null): Promise<boolean>
  /** 停掉正在答的那一问；从不抛 */
  cancel(threadId: string): Promise<void>
  select(threadId: string, topicId: string | null): void
  /** 收起失败与提醒 */
  dismiss(threadId: string): void
  applyTopic(threadId: string, topic: SideTopic): void
  applyDelta(threadId: string, delta: SideDelta): void
  applyNotice(threadId: string, message: string): void
  /** 对话被删：账一并丢掉 */
  forget(threadId: string): void
}

/** 正在答的那个话题（同一时刻至多一个：Core 只答一问） */
export function runningTopicOf(thread: SideThread): SideTopic | undefined {
  return thread.topics.find((topic) => latestSideTurn(topic).status === 'running')
}

export function selectedTopicOf(thread: SideThread): SideTopic | undefined {
  return thread.selected === null ? undefined : thread.topics.find((topic) => topic.id === thread.selected)
}

/** 新开的在前；同一刻开的按 id 定序，免得两份快照来回换位 */
const byNewest = (a: SideTopic, b: SideTopic): number =>
  (b.turns[0]?.createdAt ?? 0) - (a.turns[0]?.createdAt ?? 0) || a.id.localeCompare(b.id)

/**
 * 同一个话题的两份快照里哪份更新：问得多的更新；同样多时已收口的比还在答的新（收口只会在答之后），
 * 再比最后一问的更新时刻与已经流出来的长度。两份一样新时留手里那份（`held`）。
 */
export function fresherTopic(held: SideTopic, incoming: SideTopic): SideTopic {
  if (incoming.turns.length !== held.turns.length) return incoming.turns.length > held.turns.length ? incoming : held
  const a = latestSideTurn(held)
  const b = latestSideTurn(incoming)
  const settledA = a.status === 'running' ? 0 : 1
  const settledB = b.status === 'running' ? 0 : 1
  if (settledA !== settledB) return settledB > settledA ? incoming : held
  if (a.updatedAt !== b.updatedAt) return b.updatedAt > a.updatedAt ? incoming : held
  return b.answer.length > a.answer.length ? incoming : held
}

const messageOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

export function createSideStore(api: SideApi): SideStore {
  const store = createFeatureStore<SideState>(() => ({ byThread: {} }))
  const inflight = new Map<string, Promise<void>>()
  /** 删掉的对话：还在路上的读表应答与通知不能把它的账写回来（对话号不复用） */
  const dropped = new Set<string>()

  const of = (threadId: string): SideThread => store.getState().byThread[threadId] ?? EMPTY_SIDE_THREAD
  const patch = (threadId: string, change: (thread: SideThread) => SideThread): void => {
    if (dropped.has(threadId)) return
    store.setState((s) => {
      const held = s.byThread[threadId] ?? EMPTY_SIDE_THREAD
      const next = change(held)
      return next === held ? s : { byThread: { ...s.byThread, [threadId]: next } }
    })
  }
  /** 把一批快照并进话题表：同一个话题留更新的那份 */
  const merge = (topics: readonly SideTopic[], incoming: readonly SideTopic[]): readonly SideTopic[] => {
    const byId = new Map(topics.map((topic) => [topic.id, topic]))
    for (const topic of incoming) {
      const held = byId.get(topic.id)
      byId.set(topic.id, held === undefined ? topic : fresherTopic(held, topic))
    }
    return [...byId.values()].sort(byNewest)
  }

  const fetchTopics = async (threadId: string): Promise<void> => {
    try {
      const topics = await api.listSide(threadId)
      patch(threadId, (thread) => ({ ...thread, loaded: true, topics: merge(thread.topics, topics) }))
    } catch (cause) {
      patch(threadId, (thread) => ({ ...thread, loaded: true, error: messageOf(cause) }))
    }
  }

  const load = (threadId: string): Promise<void> => {
    const running = inflight.get(threadId)
    if (running !== undefined) return running
    const request = fetchTopics(threadId).finally(() => {
      inflight.delete(threadId)
    })
    inflight.set(threadId, request)
    return request
  }

  const applyTopic = (threadId: string, topic: SideTopic): void => {
    patch(threadId, (thread) => ({ ...thread, topics: merge(thread.topics, [topic]) }))
  }

  return {
    store,
    of,
    load,
    reloadLoaded() {
      for (const [threadId, thread] of Object.entries(store.getState().byThread)) {
        if (thread.loaded) void load(threadId)
      }
    },
    async ask(threadId, question, topicId) {
      const thread = of(threadId)
      if (thread.asking || runningTopicOf(thread) !== undefined) return false
      const target = topicId === undefined ? thread.selected : topicId
      patch(threadId, (held) => ({ ...held, asking: true, error: null, notice: null }))
      try {
        const topic = await api.askSide(threadId, question, target)
        applyTopic(threadId, topic)
        patch(threadId, (held) => ({ ...held, asking: false, selected: topic.id }))
        return true
      } catch (cause) {
        patch(threadId, (held) => ({ ...held, asking: false, error: messageOf(cause) }))
        return false
      }
    },
    async cancel(threadId) {
      const running = runningTopicOf(of(threadId))
      try {
        const cancelled = await api.cancelSide(threadId, running?.id ?? null)
        /* Core 说没有在答的，而手里那份还画着「正在答」：漏了收口那一份快照，重读一次 */
        if (!cancelled && running !== undefined) await load(threadId)
      } catch (cause) {
        patch(threadId, (held) => ({ ...held, error: messageOf(cause) }))
      }
    },
    select(threadId, topicId) {
      patch(threadId, (thread) => (thread.selected === topicId ? thread : { ...thread, selected: topicId }))
    },
    dismiss(threadId) {
      patch(threadId, (thread) =>
        thread.error === null && thread.notice === null ? thread : { ...thread, error: null, notice: null },
      )
    },
    applyTopic,
    applyDelta(threadId, { delta, offset, topicId, turn }) {
      if (dropped.has(threadId)) return
      const topic = of(threadId).topics.find((held) => held.id === topicId)
      const current = topic?.turns[turn]
      if (topic === undefined || current === undefined) {
        void load(threadId)
        return
      }
      /* 重读的应答里已经带着这一截（应答与推送交错）：不重复拼 */
      if (
        current.answer.length >= offset + delta.length &&
        current.answer.slice(offset, offset + delta.length) === delta
      ) {
        return
      }
      if (current.status !== 'running' || current.answer.length !== offset) {
        void load(threadId)
        return
      }
      const turns = topic.turns.map((held, index) => (index === turn ? { ...held, answer: held.answer + delta } : held))
      applyTopic(threadId, { ...topic, turns })
    },
    applyNotice(threadId, message) {
      patch(threadId, (thread) => ({ ...thread, notice: message }))
    },
    forget(threadId) {
      dropped.add(threadId)
      inflight.delete(threadId)
      store.setState((s) => {
        if (s.byThread[threadId] === undefined) return s
        const { [threadId]: _gone, ...rest } = s.byThread
        return { byThread: rest }
      })
    },
  }
}
