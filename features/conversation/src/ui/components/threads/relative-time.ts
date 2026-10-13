/* 时间退回行尾那一格的元数据；两级投影分开：时钟跳一次不该让整屏重跑解析。 */

import { DAY, HOUR, MINUTE, narrowUnit } from '../semantics/duration'

const spoken = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })

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

/** 一周内给时长、更久给日期：「418 天」不解决任何问题。未来时刻（时钟偏差）读作「现在」。 */
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

  return stamp.getFullYear() === new Date(reference).getFullYear() ? sameYear.format(stamp) : otherYear.format(stamp)
}

export function formatAbsolute(instant: number): string {
  return exact.format(instant)
}

/*
 * 与 formatElapsed 同一道阶梯，反着算。一天以上没有属于自己的期限（只在本地午夜改口，而午夜由 nextChangeIn 无条件算进去）。
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

/** 下一个本地午夜。用日历推进一天而非加 86_400_000：夏令时切换那天是 23/25 小时，加固定毫秒会排错一小时。 */
function nextMidnight(instant: number): number {
  const at = new Date(instant)

  at.setHours(0, 0, 0, 0)
  at.setDate(at.getDate() + 1)

  return at.getTime()
}

/**
 * 入参是一串已解析好的时刻 —— 期限没有理由再认识分组。午夜无条件算进去：跨过午夜「1天」要改口「2天」，哪怕列表是空的。
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

export interface DatedMember<T> {
  readonly thread: T
  /** 解析过的时刻；无法解析时为 NaN。 */
  readonly instant: number
  /** 同一时刻的准确说法，给悬停与读屏；无法解析时为 null。 */
  readonly absolute: string | null
}

export interface PaintedMember<T> extends DatedMember<T> {
  /** 相对文案；时刻无法解析时为 null，此时该行不画时间。 */
  readonly elapsed: string | null
}

/* name 可以是 null：那一组的目录还没有被记下来。两级投影原样带过这件事，不中途替它编一个名字。 */
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
export function paintedGroupsOf<T>(groups: readonly DatedGroup<T>[], reference: number): readonly PaintedGroup<T>[] {
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
