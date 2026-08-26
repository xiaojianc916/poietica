/*
 * 时长。
 *
 * 与 threads/relative-time.ts 的 formatElapsed 是两种量，不是一种量的两个档：那边说
 * 的是「多久以前」（第一档把 0–60 秒整段读作「现在」，一周以上转成日期），这里
 * 说的是「持续了多久」（工具调用绝大多数就活在那 60 秒里，而它永远不会转成日期）。
 * 两者共用一个函数才是错的。
 *
 * 真正共用的是下面这个工厂与几个常量（relative-time.ts 与 goal-island 从这里拿）。
 * 数量词、词序、语言交给 Intl：narrow 的 unit 在 zh 下是「31分钟」，在 en 下是 "31m"。
 */

export const SECOND = 1_000
export const MINUTE = 60_000
export const HOUR = 3_600_000
export const DAY = 86_400_000

/**
 * 一个 narrow 的单位格式器。
 *
 * 小数位默认关掉：除了秒档，所有档位交进来的都是 Math.floor 过的整数，而
 * NumberFormat 默认允许三位小数 —— 那是一个只可能在将来某次改动里悄悄生效的口子。
 */
export function narrowUnit(unit: string, maximumFractionDigits = 0): Intl.NumberFormat {
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits,
    style: 'unit',
    unit,
    unitDisplay: 'narrow',
  })
}

/* 秒档带一位小数：一次 0.2 秒的读盘与一次 0.9 秒的读盘不是同一回事。 */
const second = narrowUnit('second', 1)
const minute = narrowUnit('minute')
const hour = narrowUnit('hour')

/**
 * 一段时长的说法，读不出来就交回 null（由调用方决定不画）。
 *
 * 不足一秒不报：那种调用快到没有人来得及读，报出来只是每张卡片闪一下。
 * 一分钟以上补上次级单位 —— 「1分12秒」，因为分钟档的取整会吃掉最多 59 秒，
 * 而一次跑了 1 分 59 秒的子代理与一次跑了 1 分整的子代理，差别正在那里。
 */
export function formatDuration(span: number): string | null {
  if (!Number.isFinite(span) || span < SECOND) {
    return null
  }

  if (span < MINUTE) {
    return second.format(Math.floor(span / 100) / 10)
  }

  if (span < HOUR) {
    const minutes = Math.floor(span / MINUTE)
    const seconds = Math.floor((span % MINUTE) / SECOND)

    return seconds === 0
      ? minute.format(minutes)
      : `${minute.format(minutes)} ${second.format(seconds)}`
  }

  const hours = Math.floor(span / HOUR)
  const minutes = Math.floor((span % HOUR) / MINUTE)

  return minutes === 0 ? hour.format(hours) : `${hour.format(hours)} ${minute.format(minutes)}`
}
