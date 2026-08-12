/*
 * 有距离的滚动位移：一条管线，两个调用方。
 *
 * 「回到最新」（follow-latest）与「跳到某一轮」（agent-activity-feed 的 reveal）是
 * 同一种运动：人下了一个有目的地的指令，视口带着看得见的位移过去。运动的实现因此
 * 只有一份；两个调用方各自持有自己的状态机与取消判据，这里只负责运动本身。
 *
 * 不用平台的 scrollTo({ behavior: 'smooth' })，三条都不成立：时长与曲线由 UA 定、
 * 没有接口；它在开始时捕获一次目标，而虚拟列表的目标每帧都在动（行被真高替换、
 * 内容边写边长）；它的收尾会被任何一次程序化的瞬时写入提前放行。标杆同样是自己
 * 写循环并每帧重读目标（use-stick-to-bottom，Vercel AI Elements 的 Conversation
 * 用的就是它）。
 */

/**
 * 一段位移走多久。
 *
 * 固定值，与要走的距离无关，所以一段很长的对话与一段很短的对话的手感是同一个 ——
 * 这个动作不是在遍历中间内容，是在换一个落点。
 *
 * 量级取自仓库里最近的同类数字 --cp-motion-settle（320ms）。没有直接吃那个令牌：
 * 它是 CSS 自定义属性，从这里拿要 getComputedStyle 再解析字符串，还会把滚动位置
 * 的行为拴到皮肤层上 —— 这个数字描述的是行为，不是外观。
 */
export const GLIDE_MS = 360

/**
 * 位移的曲线：三次缓出。
 *
 * 前段快、末段慢。匀速读起来像机器在拖，而缓出读起来是「被拽了一把然后放手」——
 * 这是位移类过渡的通行形状，也是这个界面上其它过渡的形状（--ui-ease-standard 一族
 * 同样是减速为主）。
 */
export function easeOut(fraction: number): number {
  const remaining = 1 - fraction

  return 1 - remaining * remaining * remaining
}

/**
 * 位移在某一时刻该落在哪；返回 null 表示这一段走完了。
 *
 * 目标由调用方每帧重算传入，不在开始时捕获：虚拟列表的总高是估出来的，行被真实
 * 测量后它会改，内容边写边长时它也在改。捕获一次目标的做法（平台的平滑滚动就是
 * 这么做的）会在半路把终点定死在一个已经不存在的位置上。
 *
 * 两个终止条件都不依赖运气：时间到，或者目标跑到了行进方向的后面（内容缩短、
 * 重测都会造成）。
 *
 * 夹紧是为了单调：目标在途中移动会让插值落到当前位置的反方向，而位移途中任何
 * 一次逆行写入都是一下可见的抽动。宁可写一个没有位移的值（浏览器不会为它派发
 * 滚动事件），也不往回顶。方向由 origin → target 决定，向上向下同一条规则。
 */
export function glideStep(
  origin: number,
  current: number,
  target: number,
  fraction: number,
): number | null {
  if (fraction >= 1) {
    return null
  }

  const toward = target - origin

  if (toward >= 0 ? target <= current : target >= current) {
    return null
  }

  const next = origin + toward * easeOut(fraction)

  return toward >= 0 ? Math.max(next, current) : Math.min(next, current)
}

export interface GlideArgs {
  /** 这一帧的目标偏移。每帧重读；null 表示目标已不存在，当场收尾，不再写入。 */
  readonly target: () => number | null
  /** 这一段还归不归这次指令。false 就一步都不写，也不收尾 —— 取消不走 arrive。 */
  readonly proceed: () => boolean
  /** 自然到达（含时间用尽）时的收尾。 */
  readonly arrive: () => void
}

/**
 * 起一段位移，交回取消函数。
 *
 * 到达时先把目标写实再收尾：插值只保证接近，最后一帧必须是精确的落点。取消路径
 * 不写不收 —— 位移被人打断时，滚动位置属于打断它的那个人。
 *
 * rAF 回调的时间戳与 performance.now() 同一个时间原点，所以这两个数可以直接相减。
 */
export function startGlide(viewport: HTMLElement, args: GlideArgs): () => void {
  const view = viewport.ownerDocument.defaultView
  let frame = 0

  const finish = () => {
    const goal = args.target()

    if (goal !== null) {
      viewport.scrollTop = goal
    }

    args.arrive()
  }

  /* 拆下来的节点没有帧可用：退化成瞬时落点，不留一个永远醒不来的状态。 */
  if (view === null) {
    finish()

    return () => undefined
  }

  const origin = viewport.scrollTop
  const startedAt = performance.now()

  const step = (time: number) => {
    frame = 0

    if (!args.proceed()) {
      return
    }

    const goal = args.target()

    if (goal === null) {
      args.arrive()

      return
    }

    const next = glideStep(origin, viewport.scrollTop, goal, (time - startedAt) / GLIDE_MS)

    if (next === null) {
      finish()

      return
    }

    viewport.scrollTop = next
    frame = view.requestAnimationFrame(step)
  }

  frame = view.requestAnimationFrame(step)

  return () => {
    if (frame !== 0) {
      view.cancelAnimationFrame(frame)
    }
  }
}
