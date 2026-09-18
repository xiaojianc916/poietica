import './prompt-chip.css'

import { DecoratorNode, type NodeKey, type SerializedLexicalNode } from 'lexical'
import type { ReactNode } from 'react'
import { ElementIcon, SkillIcon, ToolIcon } from '../primitives/icons'

/*
 * skill / mcp 来自面板点名；element 来自浏览器拾取 —— 字节仍住在附件册
 * （prompt-input.tsx 的 AttachmentsContext），记号只挂 token 与标签。
 */
export type PromptChipValue =
  | { readonly kind: 'skill'; readonly name: string; readonly args?: string | undefined }
  | { readonly kind: 'mcp'; readonly id: string; readonly name: string }
  | { readonly kind: 'element'; readonly assetToken: string; readonly label: string }

type SerializedChipNode = SerializedLexicalNode & { readonly value: PromptChipValue }

export function samePromptChip(left: PromptChipValue, right: PromptChipValue): boolean {
  return (
    left.kind === right.kind &&
    (left.kind === 'skill'
      ? left.name === (right.kind === 'skill' ? right.name : '')
      : left.kind === 'mcp'
        ? left.id === (right.kind === 'mcp' ? right.id : '')
        : left.assetToken === (right.kind === 'element' ? right.assetToken : ''))
  )
}

/** 一台 MCP server 在正文里被点名的写法。写与读只有这一对。 */
const MENTION = /@mcp:(\S+)/g

function mention(name: string): string {
  return `@mcp:${name}`
}

export type PromptSegment =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'mcp'; readonly name: string }

/** 正文切成「话」与「记号」两种段，顺序与原文一致。 */
export function promptSegments(text: string): readonly PromptSegment[] {
  const segments: PromptSegment[] = []
  let cursor = 0

  for (const found of text.matchAll(MENTION)) {
    const name = found[1]

    if (name === undefined) {
      continue
    }

    if (found.index > cursor) {
      segments.push({ kind: 'text', text: text.slice(cursor, found.index) })
    }

    segments.push({ kind: 'mcp', name })
    cursor = found.index + found[0].length
  }

  if (cursor < text.length) {
    segments.push({ kind: 'text', text: text.slice(cursor) })
  }

  return segments
}

/**
 * 一枚记号，画出来的样子。
 *
 * 草稿与转录共用它：一句话发出去之后，人挂的技能与点名的 MCP 仍然是同一枚
 * 记号，两处各画一遍就会各漂一份。
 */
export function PromptChip({
  kind,
  name,
}: {
  readonly kind: PromptChipValue['kind']
  readonly name: string
}) {
  /* MCP 是一类东西，不是一堆牌子：与工具调用行同一枚字形。元素上下文用拾取光标。 */
  const Glyph = kind === 'mcp' ? ToolIcon : kind === 'element' ? ElementIcon : SkillIcon

  /* 描边字形随文字走 currentColor；两枚记号的几何同归 prompt-chip.css。 */
  return (
    <span className="assistant-prompt-chip">
      <Glyph aria-hidden="true" className="assistant-prompt-chip__icon" />
      {name}
    </span>
  )
}

/**
 * 草稿里的一枚记号。
 *
 * DecoratorNode 而不是 TextNode：屏幕上写的与交给 agent 的不是同一串（技能整个
 * 不进正文，MCP 进的是 @mcp: 前缀那一串），而 getTextContent 是官方给这件事的那
 * 一格。它没有自己的动作 —— 删一枚就是退格，那是编辑器自己的事。
 */
export class ChipNode extends DecoratorNode<ReactNode> {
  readonly #value: PromptChipValue

  static override getType(): string {
    return 'chip'
  }

  static override clone(node: ChipNode): ChipNode {
    return new ChipNode(node.#value, node.__key)
  }

  static override importJSON(serialized: SerializedChipNode): ChipNode {
    /* 基类那半份 JSON 由 updateFromJSON 落地，官方节点文档的写法。 */
    return new ChipNode(serialized.value).updateFromJSON(serialized)
  }

  constructor(value: PromptChipValue, key?: NodeKey) {
    super(key)
    this.#value = value
  }

  value(): PromptChipValue {
    return this.#value
  }

  override exportJSON(): SerializedChipNode {
    return { ...super.exportJSON(), value: this.#value }
  }

  override createDOM(): HTMLElement {
    /* 样子归 PromptChip：宿主只是编辑器要的那个位置。 */
    return document.createElement('span')
  }

  override updateDOM(): false {
    return false
  }

  override isInline(): true {
    return true
  }

  override getTextContent(): string {
    return this.#value.kind === 'mcp' ? mention(this.#value.name) : ''
  }

  override decorate(): ReactNode {
    const value = this.#value

    return (
      <span contentEditable={false}>
        <PromptChip kind={value.kind} name={value.kind === 'element' ? value.label : value.name} />
      </span>
    )
  }
}

export function $createChipNode(value: PromptChipValue): ChipNode {
  return new ChipNode(value)
}
