const KIMI_FILE_SCHEME = 'kimi-file://'

export interface DaemonFileRef {
  readonly fileId: string
}

function parseDaemonFileRef(url: string): DaemonFileRef | undefined {
  if (!url.startsWith(KIMI_FILE_SCHEME)) return undefined
  const rest = url.slice(KIMI_FILE_SCHEME.length)
  const queryAt = rest.indexOf('?')
  const fileId = queryAt === -1 ? rest : rest.slice(0, queryAt)
  return fileId.length > 0 ? { fileId } : undefined
}

interface MediaRefPart {
  readonly type: string
  readonly text?: string
  readonly imageUrl?: { readonly url?: string }
  readonly videoUrl?: { readonly url?: string }
}

export function daemonFileRefFromPairingPart(
  part: MediaRefPart,
): { readonly kind: 'image' | 'video'; readonly ref: DaemonFileRef } | undefined {
  if (part.type !== 'image_url' && part.type !== 'video_url') return undefined
  const url = part.type === 'image_url' ? part.imageUrl?.url : part.videoUrl?.url
  if (typeof url !== 'string') return undefined
  const ref = parseDaemonFileRef(url)
  if (ref === undefined) return undefined
  return { kind: part.type === 'image_url' ? 'image' : 'video', ref }
}
