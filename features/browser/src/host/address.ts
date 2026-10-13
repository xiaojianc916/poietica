/* 地址归一：只有 http(s) 与本地 file: 进得来，裸主机名补 scheme；搜索词不是地址。 */

export function normalizeAddress(input: string): string | null {
  const trimmed = input.trim()

  if (trimmed.length === 0) {
    return null
  }

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

  return scheme === 'https' && !parsed.hostname.includes('.') ? null : parsed.toString()
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
