/**
 * URL 路径 → 解码后的段；任何可疑的段都让整条请求作废（返回 undefined）。
 *
 * 两个自定义协议（poietica-app 的应用外壳、poietica-asset 的用户资产）共用这一份：坏的百分号编码
 * （decodeURIComponent 抛 URIError）、`.` / `..`、解码后藏着的 `/` `\` 与 NUL 都在这里挡掉，
 * 处理器拿到的每一段都能直接当文件名用。
 */
export function safePathSegments(pathname: string): string[] | undefined {
  const segments: string[] = []
  for (const segment of pathname.split('/')) {
    if (segment.length === 0) continue
    let decoded: string
    try {
      decoded = decodeURIComponent(segment)
    } catch {
      return undefined
    }
    if (decoded === '.' || decoded === '..' || /[/\\\0]/.test(decoded)) return undefined
    segments.push(decoded)
  }
  return segments
}
