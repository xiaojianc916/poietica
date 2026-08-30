import type { ThreadRecord } from '@poietica/agent-contract'
import { byRecency, type ThreadListItem, workspaceIdOf } from './thread-order'
import { nameOf } from './thread-title'

/** 一张空列表。引用固定，所以「还什么都没有」不会每次换一个数组。 */
export const NO_ITEMS: readonly ThreadListItem[] = []

/** 一次投影的产物。 */
export interface ProjectedThreads {
  /** 列表要用的那些行，次序已经排好。 */
  readonly items: readonly ThreadListItem[]
  /** 按对话号找回原记录，一次索引。 */
  readonly byId: ReadonlyMap<string, ThreadRecord>
}

/**
 * 列表的顺序，只有这一处说了算。
 *
 * 置顶在前，然后按活动时间倒序 —— 与库里那条 ORDER BY 同一条规则，因为它
 * 们排的是同一个列表。库那份是初次读回来时的顺序；而说一句话之后 updatedAt
 * 是先在本地改的（见 threads-store 的 noteUserMessage），排序必须跟着在本地
 * 重算一次，否则「刚说过话的对话浮上来」要等到下一次整表刷新才发生。
 *
 * 这不是两个真源：规则只写了一遍，执行了两次 —— 一次在读回来的那一刻，一次
 * 在本地推进的那一刻。
 *
 * 刚开口、平台还没记下的那些自带此刻的时间戳，所以它们自然排在最前，不需要
 * 一条额外的「pending 优先」规则。
 */
function ordered(
  threads: readonly ThreadRecord[],
  pending: readonly ThreadRecord[],
): readonly ThreadRecord[] {
  const known = new Set(threads.map((thread) => thread.threadId))
  const extra = pending.filter((thread) => !known.has(thread.threadId))
  const all = extra.length === 0 ? threads : [...extra, ...threads]

  return [...all].sort(byRecency)
}

/*
 * 把快照投影成列表要用的形状，一次。
 *
 * 逐行复用值没变的对象，整张列表没变时连数组本身都不换——于是「某条对话
 * 拿到了选择器」不会让侧栏的任何一行重画。
 *
 * 它住在这里而不是 store 里，因为它回答的是「一行长什么样、按什么次序」，
 * 与同目录的 thread-order（次序与分组）是同一个问题的两半，而与「谁改了状态、
 * 谁被叫醒」无关。逐行复用的缓存是这段计算自己的，所以它跟着计算走。
 */
export class ThreadProjection {
  /* 值没变的行复用同一个对象，行组件因此可以被跳过。 */
  #items = new Map<string, ThreadListItem>()

  /* 上一次交出去的那张列表。整张没变就原样交回它。 */
  #last: readonly ThreadListItem[] = NO_ITEMS

  of(
    threads: readonly ThreadRecord[],
    pending: readonly ThreadRecord[],
    provisional: ReadonlyMap<string, string>,
    fallbackWorkspaceId?: string,
  ): ProjectedThreads {
    const listed = ordered(threads, pending)
    const byId = new Map<string, ThreadRecord>()
    const kept = new Map<string, ThreadListItem>()
    const items: ThreadListItem[] = []
    let same = listed.length === this.#last.length

    for (const [index, thread] of listed.entries()) {
      byId.set(thread.threadId, thread)

      const item = this.#itemFor(thread, provisional, fallbackWorkspaceId)

      kept.set(thread.threadId, item)
      items.push(item)

      if (same && this.#last[index] !== item) {
        same = false
      }
    }

    this.#items = kept
    this.#last = same ? this.#last : items

    return { byId, items: this.#last }
  }

  #itemFor(
    thread: ThreadRecord,
    provisional: ReadonlyMap<string, string>,
    fallbackWorkspaceId?: string,
  ): ThreadListItem {
    const title = nameOf(thread, provisional.get(thread.threadId))
    const isPinned = thread.pinned === true
    const workspaceId = workspaceIdOf(thread, fallbackWorkspaceId)
    const last = this.#items.get(thread.threadId)

    /* 分组也是这一行的样子的一部分。漏掉它，一条换了工作目录、而标题／置顶／
    时间都没变的对话会留在上一个组里。 */
    if (
      last !== undefined &&
      last.title === title &&
      last.isPinned === isPinned &&
      last.updatedAt === thread.updatedAt &&
      last.workspaceId === workspaceId
    ) {
      return last
    }

    return {
      id: thread.threadId,
      title,
      isPinned,
      updatedAt: thread.updatedAt,
      workspaceId,
    }
  }
}
