/*
 * 时间的读写法（审查 R-14 / R-15）：都按任务自己的时区（IANA 名）。
 * 时区读不懂时退回本机时区 —— 计划校验早已拦下无效时区，这里只求不抛。
 */

function partsOf(at: number, timeZone: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormatPart[] {
  try {
    return new Intl.DateTimeFormat('en-US', { ...options, timeZone }).formatToParts(at)
  } catch {
    return new Intl.DateTimeFormat('en-US', options).formatToParts(at)
  }
}

const FIELDS: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
}

/** 'MM-DD HH:mm'：对话抬头与线程标题用 */
export function wallTime(at: number, timeZone: string): string {
  const parts = partsOf(at, timeZone, FIELDS)
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === type)?.value ?? '00'
  return `${part('month')}-${part('day')} ${part('hour')}:${part('minute')}`
}

/** 带时差的 ISO 8601（'2026-05-02T09:00:00+08:00'）：交给 agent 的时间一律这样写，它读得懂、也照这个格式写回来 */
export function isoIn(at: number, timeZone: string): string {
  const parts = partsOf(at, timeZone, FIELDS)
  const num = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((p) => p.type === type)?.value ?? 0)
  const pad = (n: number): string => String(n).padStart(2, '0')
  const wall = Date.UTC(num('year'), num('month') - 1, num('day'), num('hour'), num('minute'), num('second'))
  const offsetMinutes = Math.round((wall - Math.floor(at / 1000) * 1000) / 60_000)
  const sign = offsetMinutes < 0 ? '-' : '+'
  const abs = Math.abs(offsetMinutes)
  return `${num('year')}-${pad(num('month'))}-${pad(num('day'))}T${pad(num('hour'))}:${pad(num('minute'))}:${pad(
    num('second'),
  )}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}

const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/

/** 只收带时差（或 Z）的 ISO 8601：不带时差的「09:00」到底是哪个时区，模型和我们都说不准 */
export function parseIsoWithOffset(text: string): number | null {
  if (!ISO_WITH_OFFSET.test(text.trim())) return null
  const at = Date.parse(text.trim())
  return Number.isNaN(at) ? null : at
}

/** Core 进程所在机器的时区 = 用户的时区（桌面应用，Core 就跑在用户电脑上） */
export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}
