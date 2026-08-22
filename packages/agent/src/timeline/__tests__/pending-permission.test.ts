import { describe, expect, it } from 'vitest'
import type { PermissionItem, TimelineItem, TimelineState } from '../timeline-contract'
import { activeScope, pendingPermission, type WaitingScope } from '../timeline-queries'

/*
 * 并行子代理会让一轮里同时挂着几个请求（ADR 0002）。
 *
 * 交出最晚那一个，先问的几个就永远等不到按钮 —— 原生侧的 oneshot 收不到答复，
 * 卡片停在 in_progress，这一轮再也结束不了。所以顺序本身就是不变式。
 */

/*
 * 两个构造函数，不是一个带开关的：exactOptionalPropertyTypes 下「缺席」与
 * 「值为 undefined」不是一回事，而条件展开产出的正是后者。
 */
function asked(requestId: string, turn: number): PermissionItem {
  return {
    type: 'permission',
    id: `permission-${requestId}`,
    turn,
    at: 0,
    requestId,
    title: requestId,
  }
}

function answered(requestId: string, turn: number): PermissionItem {
  return {
    ...asked(requestId, turn),
    resolution: { decision: 'approved' },
  }
}

/*
 * 三格里只有 status 对这几个用例是常量。
 *
 * 它不是可以省掉的一格：「有没有人在等」的权威是状态本身，转录只回答「等的是
 * 哪一个」。所以问句必须带上它 —— 一条没答复的请求留在一轮已经落定的转录里是
 * 常态（原生侧的桌子随轮次收走了），那时把它交出去，摊在输入框上方的就是一条
 * 按下去没有任何效果的审批带。
 */
function waiting(items: readonly TimelineItem[]): WaitingScope {
  return { items, status: 'awaiting_permission' }
}

describe('pendingPermission', () => {
  it('交出本段最早那个还没答复的请求', () => {
    const items: readonly TimelineItem[] = [asked('a', 1), asked('b', 1), asked('c', 1)]

    expect(pendingPermission(waiting(items))?.requestId).toBe('a')
  })

  it('答掉一个，下一个顶上来', () => {
    const items: readonly TimelineItem[] = [answered('a', 1), asked('b', 1), asked('c', 1)]

    expect(pendingPermission(waiting(items))?.requestId).toBe('b')
  })

  it('不越过段边界：封口段里的请求不再交出', () => {
    const state: TimelineState = {
      status: 'awaiting_permission',
      sealed: [{ turn: 0, items: [asked('old', 0)] }],
      active: { turn: 1, items: [asked('now', 1)] },
      lastSeq: 2,
      spans: [],
    }

    expect(pendingPermission(activeScope(state))?.requestId).toBe('now')
  })

  it('全部答完就没有了', () => {
    const items: readonly TimelineItem[] = [answered('a', 1), answered('b', 1)]

    expect(pendingPermission(waiting(items))).toBeUndefined()
  })

  /* 状态说没人在等，就没人在等 —— 倒扫连开始都不该开始。 */
  it('没在等人就不交，哪怕转录里还挂着一条没答复的请求', () => {
    const items: readonly TimelineItem[] = [asked('a', 1)]

    expect(pendingPermission({ items, status: 'running' })).toBeUndefined()
  })
})
