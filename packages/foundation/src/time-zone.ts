/** 本机 IANA 时区；运行时缺少时区数据时 Intl 返回 UTC。 */
export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}
