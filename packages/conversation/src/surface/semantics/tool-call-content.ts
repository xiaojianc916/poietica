import type { ToolCallContent } from '../../agent/tool-call'

// 协议信封 → 可显示片段的投影，无 React：读方是同样不认 React 的 file-diff 与 tool-call-facets。

export type ToolContentPart =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'diff'
      readonly path: string
      readonly oldText: string | null
      readonly newText: string
    }
  | { readonly type: 'terminal'; readonly terminalId: string }
  | { readonly type: 'link'; readonly uri: string; readonly name: string | null }
  | { readonly type: 'opaque'; readonly label: string }
  | { readonly type: 'command'; readonly command: string; readonly language: string }
  | { readonly type: 'prose'; readonly text: string }
  | { readonly type: 'image'; readonly data: string; readonly mimeType: string }
  | {
      readonly type: 'todo'
      readonly items: readonly {
        readonly title: string
        readonly status: 'done' | 'in_progress' | 'pending'
      }[]
    }

const OPAQUE_LABELS: Record<string, string> = {
  audio: '一段音频',
}

// 带正文就当正文画，只有字节时退回链接。
function resourcePart(resource: {
  readonly uri: string
  readonly text?: string | undefined
}): ToolContentPart {
  const text = resource.text

  return text === undefined || text === ''
    ? { type: 'link', uri: resource.uri, name: null }
    : { type: 'text', text }
}

function blockPart(block: {
  readonly type: string
  readonly text?: string
  readonly data?: string
  readonly mimeType?: string
}): ToolContentPart | null {
  if (block.type === 'text') {
    // 调用以空串开场、随流式填充，空气泡是噪音。
    return block.text === undefined || block.text.length === 0
      ? null
      : { type: 'text', text: block.text }
  }

  if (block.type === 'image' && typeof block.data === 'string') {
    return { type: 'image', data: block.data, mimeType: block.mimeType ?? 'image/png' }
  }

  return { type: 'opaque', label: OPAQUE_LABELS[block.type] ?? '一段内容' }
}

function partOf(entry: ToolCallContent): ToolContentPart | null {
  switch (entry.type) {
    case 'command': {
      return { type: 'command', command: entry.command, language: entry.language }
    }

    case 'prose': {
      return entry.text.length === 0 ? null : { type: 'prose', text: entry.text }
    }

    case 'todo': {
      return entry.items.length === 0 ? null : { type: 'todo', items: entry.items }
    }

    case 'diff': {
      return {
        type: 'diff',
        path: entry.path,
        oldText: entry.oldText ?? null,
        newText: entry.newText,
      }
    }

    case 'terminal': {
      return { type: 'terminal', terminalId: entry.terminalId }
    }

    case 'resource_link': {
      return { type: 'link', uri: entry.uri, name: entry.name ?? null }
    }

    case 'resource': {
      return resourcePart(entry.resource)
    }

    case 'content': {
      return blockPart(entry.content)
    }
  }
}

const NONE: readonly ToolContentPart[] = []

// 键是 content 数组本身（引用稳定由 reducer 冻结保证），WeakMap 随数据生命周期走。
const PARTS = new WeakMap<readonly ToolCallContent[], readonly ToolContentPart[]>()

export function toToolContentParts(
  content: readonly ToolCallContent[] | null | undefined,
): readonly ToolContentPart[] {
  if (content === undefined || content === null) {
    return NONE
  }

  const held = PARTS.get(content)

  if (held !== undefined) {
    return held
  }

  const parts: ToolContentPart[] = []

  for (const entry of content) {
    const part = partOf(entry)

    if (part !== null) {
      parts.push(part)
    }
  }

  const found: readonly ToolContentPart[] = parts.length === 0 ? NONE : parts

  PARTS.set(content, found)

  return found
}
