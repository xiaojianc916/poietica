import type { TranscriptPage } from '@poietica/transcript'
import type { OmpMessage } from '../../history'

export const T0 = 1_700_000_000_000

export const user = (text: string, at = 0): OmpMessage => ({ role: 'user', timestamp: T0 + at, content: text })
export const assistant = (text: string, at = 0): OmpMessage => ({
  role: 'assistant',
  timestamp: T0 + at,
  content: [{ type: 'text', text }],
})
export const toolCall = (id: string, name: string, args: unknown, at = 0): OmpMessage => ({
  role: 'assistant',
  timestamp: T0 + at,
  content: [{ type: 'toolCall', id, name, arguments: args }],
})
export const toolResult = (id: string, content: unknown, isError = false): OmpMessage => ({
  role: 'toolResult',
  toolCallId: id,
  content,
  isError,
})

/** 与 UI 同一个读法：人说过的话在 turn.prompt */
export const prompts = (page: TranscriptPage): string[] =>
  page.items.flatMap((item) => (item.kind === 'turn' && item.prompt !== undefined ? [item.prompt] : []))

/** 与 UI 同一个读法：助手正文在 role === 'assistant' 的文本帧 */
export const assistantTexts = (page: TranscriptPage): string[] =>
  page.items.flatMap((item) =>
    item.kind === 'turn'
      ? item.steps.flatMap((s) =>
          s.frames.flatMap((f) => (f.kind === 'text' && f.role === 'assistant' ? [f.text] : [])),
        )
      : [],
  )

/** 与 UI 同一个读法：工具行取 content 里的文本块 */
export const toolText = (output: unknown): string => {
  const content = (output as { readonly content?: unknown } | null)?.content ?? output
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as readonly { readonly type?: unknown; readonly text?: unknown }[])
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n')
}

export const toolFrames = (page: TranscriptPage): string[] =>
  page.items.flatMap((item) =>
    item.kind === 'turn'
      ? item.steps.flatMap((s) =>
          s.frames.flatMap((f) => (f.kind === 'tool' ? [`${f.name}:${toolText(f.output)}`] : [])),
        )
      : [],
  )
