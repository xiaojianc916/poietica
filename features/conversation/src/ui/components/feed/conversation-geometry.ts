import type { VirtualItem } from '@tanstack/react-virtual'

/*
 * 一条对话上次被看见时的几何：每行多高，视线在哪一行。
 *
 * 两件事一个归属方 —— 同键、同寿、同一个用途：下一次打开这条对话时把人放回原处。
 * 分成两处存就有两个「上次看到哪儿」的答案。
 */

/** 留几条对话。再多就丢最久没被用过的那一条。 */
const KEPT = 16

export interface ConversationGeometry {
  /**
   * 上次量到的行高，首帧的总高因此就是对的。
   *
   * 快照必须由 takeSnapshot() 取：虚拟器内部按需铺开量表，直接读那份缓存拿到的是代理
   * 对象，存下来就废了。
   */
  readonly rows: readonly VirtualItem[]
  /** 视线所在的行；null = 上次在末端，回来时继续跟随末端。 */
  readonly reading: number | null
}

const kept = new Map<string, ConversationGeometry>()

/** 上次那一份。没有就交回 undefined：虚拟器退回估高，视线回到末端。 */
export function geometryOf(conversation: string): ConversationGeometry | undefined {
  const found = kept.get(conversation)

  if (found === undefined) {
    return undefined
  }

  kept.delete(conversation)
  kept.set(conversation, found)

  return found
}

/** 离开一条对话时留下几何。一行都没量到就没有几何可留，别盖掉上一次真的量到的。 */
export function keepGeometry(conversation: string, geometry: ConversationGeometry): void {
  if (geometry.rows.length === 0) {
    return
  }

  kept.delete(conversation)
  kept.set(conversation, geometry)

  for (const oldest of kept.keys()) {
    if (kept.size <= KEPT) {
      break
    }

    kept.delete(oldest)
  }
}
