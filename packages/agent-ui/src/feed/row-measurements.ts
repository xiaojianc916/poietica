import type { VirtualItem } from '@tanstack/react-virtual'

/*
 * 按对话存的行高量表。
 *
 * 冷启时虚拟器手上只有估高，一条几千行的对话要一路测下来才知道自己多高：首帧的总高
 * 是错的，落到末端的那一笔就跟着错，于是补偿、重测、再补偿。量表交回去，首帧的总高
 * 就是上次量到的那一份。
 *
 * 快照必须由 takeSnapshot() 取：虚拟器内部按需铺开量表，直接读那份缓存拿到的是代理
 * 对象，存下来就废了。
 */

/** 留几条对话的量表。再多就丢最久没被用过的那一条。 */
const KEPT = 16

const kept = new Map<string, readonly VirtualItem[]>()

/** 上次量到的那一份。没有就交回 undefined，虚拟器退回估高。 */
export function measurementsOf(conversation: string): VirtualItem[] | undefined {
  const found = kept.get(conversation)

  if (found === undefined) {
    return undefined
  }

  kept.delete(conversation)
  kept.set(conversation, found)

  /* 交出副本：这份会被虚拟器收走当自己的初值。 */
  return [...found]
}

/** 离开一条对话时把量表留下。空快照不留：那会盖掉上一次真的量到的。 */
export function keepMeasurements(conversation: string, items: readonly VirtualItem[]): void {
  if (items.length === 0) {
    return
  }

  kept.delete(conversation)
  kept.set(conversation, items)

  for (const oldest of kept.keys()) {
    if (kept.size <= KEPT) {
      break
    }

    kept.delete(oldest)
  }
}
