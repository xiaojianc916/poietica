import {
  isTerminal,
  type PermissionItem,
  type QuestionTimelineItem,
  type TimelineItem,
  type TimelineState,
  type ToolCallTimelineItem,
} from './timeline-contract'

/**
 * 转录的即时问句。
 *
 * 这几个选择器不缓存，也不该缓存：答案要么就是状态里的一个字段，要么反着走到
 * 本轮开头就收手 —— 代价是一轮的长度，不是整条对话的长度。给它们建表，建表
 * 本身比重算贵。
 *
 * 它们此前与行管线同住一屋，行管线里于是多出一份手抄的 status 清单 —— 而同一个
 * 文件里 selectIsBusy 已经在回答这个问题。现在忙碌判据只有这一个产地，
 * 行投影（presentation.ts）也从这里取。
 */

/* 没人在等时交出同一个对象：这条路径每帧都要走，而它什么都不必分配。 */
const NOBODY_WAITING = { first: undefined, count: 0 } as const

/** 只收活动段与它的状态：草稿和已封版的状态都喂得进来。 */
export interface WaitingScope {
  readonly items: readonly TimelineItem[]
  /**
   * 这一轮此刻的状态。
   *
   * 它是「有没有人在等」的权威：permission_requested 与 questions_asked 各写下
   * 自己的等待，答复帧又拿这里的答案把它算回去（见 projection.ts 的 stillWaiting）。
   * 两条队列同时在等时它装的是审批 —— 审批压过提问，与上游 phase 的派生优先级一致。
   */
  readonly status: TimelineState['status']
}

/** 活动段那一格：即时问句只问它。 */
export function activeScope(state: TimelineState): WaitingScope {
  return { items: state.active.items, status: state.status }
}

/**
 * 本段里最早那个还没被答复的请求。
 *
 * 此前这里写着「At most one: the agent waits for an answer before asking anything
 * else」——那条不变式的成立条件不是协议，是本客户端曾经在权限处理器里就地 await：
 * 派发被堵住，agent 的第二个请求根本进不来。处理器改成 connection.spawn 之后
 *（ADR 0001），堵塞没有了，一轮里同时挂着几个请求就是常态 —— Kimi 的 Agent 工具
 * 并行派几个子代理，每一个都要审批。原生侧的桌子本来就是复数的（desk.rs 里是一张
 * HashMap），只有这里是单数的。
 *
 * 于是判据从「最后一个」改成「最早一个」。仍然反向走，因为要在段边界收手；但交出的
 * 必须是最早那一个 —— 交出最后一个，先问的那几个永远轮不到有人点按钮，它们的
 * oneshot 等不到 answer()，卡片停在 in_progress，这一轮再也结束不了。
 *
 * 一次只交一个，不是一次交一叠：并行的请求彼此独立，一个个答与一叠一起答在协议上
 * 没有分别，而一个个答不需要面板改成队列。答掉一个，下一个顶上来。
 *
 * 名字不再带 select 前缀：投影层在写入路径上也读它（判断「还有没有人在等」），而
 * 那里不是在选渲染的东西。一个判据两个读者，抄成两份就会有两种「还在等」。
 *
 * 边界读的是条目自己的段号。此前读的是「撞见一条用户消息」，而那会漏掉一个能把整轮
 * 卡死的情形：agent 停在一个还没答复的请求上，人没点按钮，转头在输入框里又说了一句
 * —— 那句话排在请求后面，反向扫第一个就撞上它，面板当场消失，而原生侧还在等这个
 * 答复，界面上再没有任何入口。那句话没有开新的一段（appendUserMessage 看见还有一轮
 * 在跑就不开），所以它与那个请求同号，扫描照常走过去。
 */
export function pendingPermission(scope: WaitingScope): PermissionItem | undefined {
  return waitingIn(scope).first
}

/**
 * 本段里还没被答复的请求一共几个。
 *
 * 审批带上那个 1/3 的分母。分子恒是 1 —— 交出去的永远是最早那一个。
 *
 * 它和 pendingPermission 共用同一趟扫描，因为它们问的是同一件事的两面：
 * 抄第二个循环，边界条件就会有两份，而漂移的那一天不需要谁犯错。
 */
export function pendingPermissionCount(scope: WaitingScope): number {
  return waitingIn(scope).count
}

/**
 * 待答的那个请求指向的调用。
 *
 * 请求帧只带一个号：这次调用在做什么由它自己的条目说，那是唯一的事实来源。
 * 号还没落成条目（请求先于宣告到达）就交回 undefined。
 */
export function pendingPermissionCall(scope: WaitingScope): ToolCallTimelineItem | undefined {
  const toolCallId = waitingIn(scope).first?.toolCall?.toolCallId

  if (toolCallId === undefined) {
    return undefined
  }

  for (let index = scope.items.length - 1; index >= 0; index -= 1) {
    const item = scope.items[index]

    if (item?.type === 'tool_call' && item.toolCallId === toolCallId) {
      return item
    }
  }

  return undefined
}

/*
 * 那一趟倒扫本身。
 *
 * 交出的对象是过路的：两个导出各取一格，一个是转录里那个条目本身（引用稳定），
 * 一个是数字。订阅它们的界面因此不会被流式追加叫醒。
 */
function waitingIn(scope: WaitingScope): {
  readonly first: PermissionItem | undefined
  readonly count: number
} {
  /*
   * 没在等人，就没有人在等。
   *
   * 这不是一层缓存，是把问题问到它的答案所在的那一格：状态由帧驱动，逐帧维护着
   * 这件事。此前每一帧都为这个问题倒扫整段 —— 而这两个导出各是一条切片订阅，
   * getSnapshot 在渲染期与提交期各被调一次，于是一帧至少四趟，趟趟的答案都是「没有」。
   *
   * 它同时改掉一处语义错：一轮已经落定（completed / failed / cancelled）时，那条
   * 没等到答复的请求不再被交出来 —— 原生侧的桌子早已随轮次收走，摊在输入框上方的
   * 是一条按下去没有任何效果的审批带。判据与工具卡片那一处同源：轮次一停，它就
   * 不再是活的。
   */
  if (scope.status !== 'awaiting_permission') {
    return NOBODY_WAITING
  }

  const items = scope.items
  let first: PermissionItem | undefined
  let count = 0

  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]

    if (item === undefined) {
      continue
    }

    if (item.type === 'permission' && item.resolution === undefined) {
      first = item
      count += 1
    }
  }

  return { first, count }
}

/**
 * 本段里最早那组还没结清的题。
 *
 * 与 pendingPermission 同一条扫描纪律，只有一处不同：提前返回的判据不能只看
 * awaiting_question。status 只有一个词，两条队列同时在等时它装的是审批（见
 * projection.ts 的 stillWaiting）—— 那时这一趟照样要扫，否则被压在底下的那组题
 * 永远查不出来，面板上再也没有它的入口。
 */
export function pendingQuestion(scope: WaitingScope): QuestionTimelineItem | undefined {
  if (scope.status !== 'awaiting_permission' && scope.status !== 'awaiting_question') {
    return undefined
  }

  const items = scope.items
  let first: QuestionTimelineItem | undefined

  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]

    if (item === undefined) {
      continue
    }

    if (item.type === 'question' && item.resolution === undefined) {
      first = item
    }
  }

  return first
}

/**
 * 此刻还在跑的子代理数：kap 的 agent_call 与 task 两档。
 *
 * 不按段收口 —— 后台派出去的那些（display.background）活得比一段长。终帧到达即
 * 出列，判据与工具卡片同源（isTerminal）。
 */
export function runningDelegations(state: TimelineState): number {
  let running = runningIn(state.active.items)

  for (const page of state.sealed) {
    running += runningIn(page.items)
  }

  return running
}

function runningIn(items: readonly TimelineItem[]): number {
  let running = 0

  for (const item of items) {
    if (
      item.type === 'tool_call' &&
      (item.kind === 'delegate' || item.kind === 'task') &&
      !isTerminal(item.status)
    ) {
      running += 1
    }
  }

  return running
}

export function selectIsBusy(state: TimelineState): boolean {
  return (
    state.status === 'submitted' ||
    state.status === 'running' ||
    state.status === 'cancelling' ||
    state.status === 'awaiting_permission' ||
    state.status === 'awaiting_question'
  )
}
