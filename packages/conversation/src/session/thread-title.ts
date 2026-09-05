import type { ThreadRecord } from '../agent'

const FALLBACK_TITLE = '新建对话'
const TITLE_GRAPHEMES = 48
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

export function shorten(text: string): string {
  const normalized = text.trim().replace(/\s+/gu, ' ')
  const pieces: string[] = []
  for (const part of graphemes.segment(normalized)) {
    if (pieces.length === TITLE_GRAPHEMES) {
      return `${pieces.join('')}…`
    }
    pieces.push(part.segment)
  }
  return pieces.join('')
}
export function forkNameOf(title: string): string {
  const match = /^(.*?)(?:\s+\((\d+)\))?$/u.exec(title)
  const base = match?.[1] ?? title
  const ordinal = BigInt(match?.[2] ?? '1') + 1n
  return `${shorten(base)} (${ordinal.toString()})`
}
export function nameOf(thread: ThreadRecord | undefined): string {
  switch (thread?.titleSource) {
    case 'manual':
      return thread.title
    case 'generated':
    case 'message':
      return shorten(thread.title)
    default:
      return FALLBACK_TITLE
  }
}
