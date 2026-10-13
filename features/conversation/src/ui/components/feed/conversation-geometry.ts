import type { VirtualItem } from '@tanstack/react-virtual'

/* 一条对话上次被看见时的几何：每行多高与视线在哪一行同键同寿，分两处存就会出现两个「上次看到哪儿」。 */

const KEPT = 16

export interface ConversationGeometry {
  /** 必须由 takeSnapshot() 取：直接读虚拟器内部缓存拿到的是代理对象，存下来就废了。 */
  readonly rows: readonly VirtualItem[]
  /** null = 上次在末端，回来时继续跟随。 */
  readonly reading: number | null
}

const kept = new Map<string, ConversationGeometry>()

/** 没有就是 undefined：调用方退回估高、视线回到末端。 */
export function geometryOf(conversation: string): ConversationGeometry | undefined {
  const found = kept.get(conversation)

  if (found === undefined) {
    return undefined
  }

  kept.delete(conversation)
  kept.set(conversation, found)

  return found
}

/** 一行都没量到就别盖掉上一次真量到的。 */
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
