/* 地址归一：只有 http(s) 与本地 file: 进得来，裸主机名补 scheme；搜索词不是地址。 */

export function normalizeAddress(input: string): string | null {
  const trimmed = input.trim()

  if (trimmed.length === 0) {
    return null
  }

  if (isExplicitAddress(trimmed)) {
    return explicitAddressOf(trimmed)
  }

  if (trimmed.includes(' ')) {
    return null
  }

  return bareAuthorityOf(trimmed)
}

/** 带 scheme 的那一路（含 file:）：原样解析 */
function isExplicitAddress(trimmed: string): boolean {
  return trimmed.includes('://') || trimmed.startsWith('file:')
}

function explicitAddressOf(trimmed: string): string | null {
  const parsed = parseUrl(trimmed)
  if (parsed === null) return null
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
    return parsed.hostname.length > 0 ? parsed.toString() : null
  }
  return isLocalFile(parsed) ? parsed.toString() : null
}

/** 本地文件：空 host，且路径是绝对路径（file:///…） */
function isLocalFile(parsed: URL): boolean {
  return parsed.protocol === 'file:' && parsed.hostname.length === 0 && parsed.pathname.startsWith('/')
}

/** 裸主机名那一路：本地权威补 http，其余补 https，且必须看起来像个域名 */
function bareAuthorityOf(trimmed: string): string | null {
  const scheme = isLocalAuthority(trimmed) ? 'http' : 'https'
  const parsed = parseUrl(`${scheme}://${trimmed}`)
  if (parsed === null) return null
  return scheme === 'https' && !parsed.hostname.includes('.') ? null : parsed.toString()
}

/** 解析失败一律返回 null（调用方只关心「能不能变成地址」） */
function parseUrl(value: string): URL | null {
  try {
    return new URL(value)
  } catch {
    return null
  }
}

function isLocalAuthority(address: string): boolean {
  const authority = address.split('/')[0] ?? address
  const colon = authority.lastIndexOf(':')
  const host = colon === -1 ? authority : authority.slice(0, colon)

  return host === 'localhost' || /^\d{1,3}(\.\d{1,3}){3}$/u.test(host)
}

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

export function isNavigableAddress(url: string): boolean {
  try {
    const protocol = new URL(url).protocol

    return protocol === 'http:' || protocol === 'https:' || protocol === 'about:'
  } catch {
    return false
  }
}
