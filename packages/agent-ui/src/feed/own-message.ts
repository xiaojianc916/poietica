import type { FeedRow } from '@poietica/agent'

/*
 * 「我」说的那种行。
 *
 * 写成一个带类型的常量，而不是在比较处直写字面量：领域层要是把这个类型改名，这一行会编译
 * 失败，而一个字面量只会静静地不再匹配。
 */
const OWN_MESSAGE: FeedRow['item']['type'] = 'user_message'

/** 回答这个问题只需要两个字段，所以入参只要这两个。 */
interface OwnMessageRow {
  readonly item: {
    readonly id: string
    readonly type: string
  }
}

/**
 * 最后一条自己发出去的消息，没有则 null。
 *
 * 「我又说了一句话」是把视线带回末端的那个信号，而它是数据里的事实，不是一次点击：判据放在
 * 这里，输入框就不必把发送事件一路传进滚动区 —— 那会是一条只为一个瞬间存在的跨层管线，而
 * 它还答不对「历史恢复」与「重新发送」这些同样应该回到末端的情形。
 *
 * 从后往前找：自己说的那句话后面跟着的是这一轮的全部产出，可能上百行，而它一定在它们之前
 * 结束。空转录与只有对方说过话的转录都交回 null，调用方因此不需要区分「还没发过」与「刚发
 * 过」这两件事的第三种形态。
 */
export function latestOwnMessage(rows: readonly OwnMessageRow[]): string | null {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]

    if (row !== undefined && row.item.type === OWN_MESSAGE) {
      return row.item.id
    }
  }

  return null
}
