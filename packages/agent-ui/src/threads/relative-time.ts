/*
 * 会话列表的时间文案与期限。
 *
 * 这里没有时间桶表（今天／昨天／过去 7 天／过去 30 天／更早）：列表的一级索引是
 * 工作区而不是时间，时间退回它本来的位置 —— 行尾那一格的元数据。判据的正文在
 * packages/agent 的 thread-order.ts。
 *
 * 留下的两件事都不随分组变化：一段时长怎么说（formatElapsed），以及这一屏下
 * 一次会变的时刻（nextChangeIn）。文案与绝对时刻交给 Intl：数量词、词序、语言
 * 是平台的事。
 *
 * 两级投影保留（datedGroupsOf / paintedGroupsOf）：时刻与绝对文案只是 updatedAt
 * 的函数，时钟跳一次不该让整屏重跑一遍 Date.parse 和 dateStyle: 'full'。
 */

import { DAY, HOUR, MINUTE, narrowUnit } from '../semantics/duration'

/* 「不足一分钟」是一句话，让语言自己说，用 numeric: 'auto'。 */
const spoken = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })

/* 其余各档是时长：只有数量和单位，没有方向。常量与格式器都在 ../semantics/duration。 */
const elapsed = {
  day: narrowUnit('day'),
  hour: narrowUnit('hour'),
  minute: narrowUnit('minute'),
}
const sameYear = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' })
const otherYear = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
})
const exact = new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'short' })

function midnight(instant: number): number {
  const at = new Date(instant)

  at.setHours(0, 0, 0, 0)

  return at.getTime()
}

/** 相差几个本地日历日；跨夏令时的 23/25 小时天由取整吸收。 */
function calendarDays(instant: number, reference: number): number {
  return Math.round((midnight(reference) - midnight(instant)) / DAY)
}

/**
 * 一行的时间标签。
 *
 * 一周之内给时长，更久就给日期 —— GitHub、Slack、Linear 用的是同一道阶梯：
 * 时长在近处有用，在远处只剩噪声（「418 天」不解决任何问题）。未来时刻
 * （时钟偏差）读作「现在」，而不是负数。
 */
export function formatElapsed(instant: number, reference: number): string {
  const since = reference - instant

  if (since < MINUTE) {
    return spoken.format(0, 'second')
  }

  if (since < HOUR) {
    return elapsed.minute.format(Math.floor(since / MINUTE))
  }

  if (since < DAY) {
    return elapsed.hour.format(Math.floor(since / HOUR))
  }

  const days = calendarDays(instant, reference)

  if (days < 7) {
    return elapsed.day.format(days)
  }

  const stamp = new Date(instant)

  return stamp.getFullYear() === new Date(reference).getFullYear()
    ? sameYear.format(stamp)
    : otherYear.format(stamp)
}

/** 悬停时给出准确时刻：相对时间是概览，绝对时间才是事实。 */
export function formatAbsolute(instant: number): string {
  return exact.format(instant)
}

/*
 * 这一行的文案下一次会变的时刻 —— 与 formatElapsed 同一道阶梯，反着算。
 *
 * 一天以上没有属于自己的期限：它只在本地午夜改口，而午夜是整屏共同的边界，
 * nextChangeIn 无条件把它算进去。交回 Infinity 是把这句话说清楚。
 */
function nextChangeOf(instant: number, reference: number): number {
  const since = reference - instant

  if (since < MINUTE) {
    return instant + MINUTE
  }

  if (since < HOUR) {
    return instant + (Math.floor(since / MINUTE) + 1) * MINUTE
  }

  if (since < DAY) {
    return instant + (Math.floor(since / HOUR) + 1) * HOUR
  }

  return Number.POSITIVE_INFINITY
}

/**
 * 下一个本地午夜。
 *
 * 用日历推进一天，而不是加 86_400_000：夏令时切换的那一天是 23 或 25 小时，
 * 加固定毫秒会把闹钟排错一小时。
 */
function nextMidnight(instant: number): number {
  const at = new Date(instant)

  at.setHours(0, 0, 0, 0)
  at.setDate(at.getDate() + 1)

  return at.getTime()
}

/**
 * 整屏下一次会变的时刻。
 *
 * 入参是一串已经解析好的时刻，不是原始字符串，也不再是「分好段的结果」——
 * 分段维度已经与时间无关，期限没有理由再认识它。解析只发生在 datedGroupsOf
 * 那一趟。
 *
 * 午夜无条件算进去：跨过午夜，「1天」要改口成「2天」，哪怕没有任何一行到达
 * 自己的边界，哪怕列表是空的。
 */
export function nextChangeIn(instants: readonly number[], reference: number): number {
  let found = nextMidnight(reference)

  for (const instant of instants) {
    if (Number.isNaN(instant)) {
      continue
    }

    const at = nextChangeOf(instant, reference)

    if (at < found) {
      found = at
    }
  }

  return found
}

/** 一行里不随墙上时间变化的那一半：时刻，以及它的准确说法。 */
export interface DatedMember<T> {
  readonly thread: T
  /** 解析过的时刻；无法解析时为 NaN。 */
  readonly instant: number
  /** 同一时刻的准确说法，给悬停与读屏；无法解析时为 null。 */
  readonly absolute: string | null
}

/** 一行里随墙上时间变化的那一半：相对文案。 */
export interface PaintedMember<T> extends DatedMember<T> {
  /** 相对文案；时刻无法解析时为 null，此时该行不画时间。 */
  readonly elapsed: string | null
}

/*
 * name 可以是 null：那一组的目录还没有被记下来，见 agent-session 的
 * workspaceNameOf。这三个形状只是同一份数据的两级投影，所以它们原样带过
 * 这件事，不在中途替它补一个名字 —— 补在哪一层，都是同一个编造。
 */
export interface Grouped<T> {
  readonly id: string
  readonly name: string | null
  readonly items: readonly T[]
}

export interface DatedGroup<T> {
  readonly id: string
  readonly name: string | null
  readonly members: readonly DatedMember<T>[]
}

export interface PaintedGroup<T> {
  readonly id: string
  readonly name: string | null
  readonly members: readonly PaintedMember<T>[]
}

/** 数据变了算这一趟：解析时刻，写出绝对文案。时钟跳动与它无关。 */
export function datedGroupsOf<T extends { readonly updatedAt: string }>(
  groups: readonly Grouped<T>[],
): readonly DatedGroup<T>[] {
  return groups.map((group) => ({
    id: group.id,
    name: group.name,
    members: group.items.map((thread) => {
      const instant = Date.parse(thread.updatedAt)

      return { absolute: Number.isNaN(instant) ? null : formatAbsolute(instant), instant, thread }
    }),
  }))
}

/** 时钟跳了只算这一趟：相对文案。绝对文案与时刻原样带过。 */
export function paintedGroupsOf<T>(
  groups: readonly DatedGroup<T>[],
  reference: number,
): readonly PaintedGroup<T>[] {
  return groups.map((group) => ({
    id: group.id,
    name: group.name,
    members: group.members.map((member) => ({
      ...member,
      elapsed: Number.isNaN(member.instant) ? null : formatElapsed(member.instant, reference),
    })),
  }))
}

/** 整屏所有行的时刻，给 nextChangeIn。 */
export function instantsOf<T>(groups: readonly DatedGroup<T>[]): readonly number[] {
  return groups.flatMap((group) => group.members.map((member) => member.instant))
}
