import type { ToolCallContent } from '@poietica/agent-contract'

/**
 * The protocol envelope, flattened into things a card can draw.
 *
 * Kept separate from the component and free of React on purpose: what a tool
 * call shows is a decision worth testing against a real recording, while how it
 * is laid out is not.
 *
 * Content blocks other than text are named rather than rendered. Guessing at
 * the shape of an image or a resource block is what produced the last defect;
 * these get drawn when a recording contains one.
 *
 * 它住在 semantics，没有一行 React：做的是「协议信封 → 可显示的片段」这一次投影，
 * 读方是同样不认 React 的 file-diff 与 tool-call-facets，与 composer/question-answer
 * 同类。它不放在 timeline/，否则那些读方就得反着依赖表现层 —— 手搓的 unknown
 * 收窄正是这么长出来的。
 */

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
  | {
      readonly type: 'todo'
      readonly items: readonly {
        readonly title: string
        readonly status: 'done' | 'in_progress' | 'pending'
      }[]
    }

/* 内层的块只有 text / image / audio 三种（agent-contract 的 ToolCallContent），
   所以这张表只为画不出来的那两种留名字。resource 与 resource_link 是外层的档，
   此前挂在这里的两个键一次都取不到。 */
const OPAQUE_LABELS: Record<string, string> = {
  audio: '一段音频',
  image: '一张图片',
}

/** 一份嵌入资源：带正文就当正文画，只有字节时才退回链接。 */
function resourcePart(resource: {
  readonly uri: string
  readonly text?: string | undefined
}): ToolContentPart {
  const text = resource.text

  return text === undefined || text === ''
    ? { type: 'link', uri: resource.uri, name: null }
    : { type: 'text', text }
}

/** 协议信封里那层内块：text / image / audio 三种，只有 text 画得出来。 */
function blockPart(block: {
  readonly type: string
  readonly text?: string
}): ToolContentPart | null {
  if (block.type === 'text') {
    /* A tool call opens with an empty string and fills in as arguments
       stream. An empty bubble is noise, not information. */
    return block.text === undefined || block.text.length === 0
      ? null
      : { type: 'text', text: block.text }
  }

  return { type: 'opaque', label: OPAQUE_LABELS[block.type] ?? '一段内容' }
}

/**
 * 一枚内容块画成什么。一档一个 return，唯一的判别式主干。
 *
 * 送出去那一面的三档（command / prose / todo）也在这里：它们与信封无关，
 * 是投影层照 kap 的 display 映来的。空的散文与清单不出格。
 */
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

    /* 这两档没有 content 那一格，此前一路落到下面那行去读它。 */
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

const PARTS = new WeakMap<readonly ToolCallContent[], readonly ToolContentPart[]>()

/**
 * 一份信封摊成可显示的片段，按 content 记一次。
 *
 * 键就是 content 数组本身：它是这个投影唯一的输入，引用稳定由构造保证（reducer 冻结每一个
 * 条目，任何变更都造新对象）。WeakMap 的生命周期跟着数据而不是组件实例，卡片滚出视口被卸载
 * 时缓存不跟着走，也不需要淘汰策略。
 *
 * 值得记：同一份内容会被互不相识的几处读到，而下游按 diff 行铺屏幕的那一层正是按这个数组
 * 记账的（file-diff.ts）。
 */
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
