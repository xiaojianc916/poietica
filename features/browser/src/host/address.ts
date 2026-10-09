/*
 * 地址归一：只有 http(s) 与本地 file: 进得来，裸主机名补 scheme。
 * 与 crates/browser 的 normalize_address 同一套判据 —— 搜索词不是地址，打错的地址也不该被当成站点。
 *
 * **迁移自** legacy `apps/desktop/electron/browser/host.ts` 的同名函数，判据一字未改。
 */

export function normalizeAddress(input: string): string | null {
  const trimmed = input.trim()

  if (trimmed.length === 0) {
    return null
  }

  // 只有带 '://' 的写法才算「写明了 scheme」：'localhost:5173' 是主机加端口，不是 scheme。
  if (trimmed.includes('://') || trimmed.startsWith('file:')) {
    let parsed: URL

    try {
      parsed = new URL(trimmed)
    } catch {
      return null
    }

    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.hostname.length > 0 ? parsed.toString() : null
    }

    // 本地文件是要看的：宿主把 file: 当自定义协议装载，所以这里放行，只有带主机的 file: 才是歧义。
    return parsed.protocol === 'file:' && parsed.hostname.length === 0 && parsed.pathname.startsWith('/')
      ? parsed.toString()
      : null
  }

  if (trimmed.includes(' ')) {
    return null
  }

  const scheme = isLocalAuthority(trimmed) ? 'http' : 'https'
  let parsed: URL

  try {
    parsed = new URL(`${scheme}://${trimmed}`)
  } catch {
    return null
  }

  // 裸主机名不带点更可能是没打完的搜索词；本地地址（localhost、IP）已经在上面走了 http。
  return scheme === 'https' && !parsed.hostname.includes('.') ? null : parsed.toString()
}

function isLocalAuthority(address: string): boolean {
  const authority = address.split('/')[0] ?? address
  const colon = authority.lastIndexOf(':')
  const host = colon === -1 ? authority : authority.slice(0, colon)

  return host === 'localhost' || /^\d{1,3}(\.\d{1,3}){3}$/u.test(host)
}

/** 不是地址的字符串（例如导航事件回来的 about:blank）按「有东西可摆」判据时用得上。 */
export function displayHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

export function isWebAddress(url: string): boolean {
  try {
    const protocol = new URL(url).protocol

    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

/** 只允许 http:、https:、about:（07 页 §12D 导航限制）。 */
export function isNavigableAddress(url: string): boolean {
  try {
    const protocol = new URL(url).protocol

    return protocol === 'http:' || protocol === 'https:' || protocol === 'about:'
  } catch {
    return false
  }
}
