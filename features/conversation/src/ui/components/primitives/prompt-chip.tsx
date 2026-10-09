import './prompt-chip.css'

import { DecoratorNode, type NodeKey, type SerializedLexicalNode } from 'lexical'
import type { ReactNode, SVGProps } from 'react'
import { ElementIcon, SkillIcon, ToolIcon } from '../primitives/icons'

/* DSH composer chip 的原字形（圆角纸 + 两行字）；图标库的 FileText 带折角，是另一张图。 */
function FileDocIcon({ className }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      strokeWidth={1}
      viewBox="0 0 16 16"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M12.5 1.32617C13.3039 1.32617 14 1.95171 14 2.77637V13.2246C13.9996 14.0489 13.3036 14.6738 12.5 14.6738H3.5C2.69637 14.6738 2.00042 14.0489 2 13.2246V2.77637C2 1.95171 2.69613 1.32617 3.5 1.32617H12.5ZM3.5 2.32617C3.1993 2.32617 3 2.55186 3 2.77637V13.2246C3.00044 13.4489 3.19963 13.6738 3.5 13.6738H12.5C12.8004 13.6738 12.9996 13.4489 13 13.2246V2.77637C13 2.55186 12.8007 2.32617 12.5 2.32617H3.5Z"
        fill="currentColor"
      />
      <path d="M4.9375 5.90295H11.0625" stroke="currentColor" />
      <path d="M4.9375 9.02991H8.27841" stroke="currentColor" />
    </svg>
  )
}

/*
 * element 与 file 的字节住在附件册（prompt-input.tsx 的 AttachmentsContext），
 * 记号只挂 token 与标签：记号在不在，就是那份字节发不发。
 */
export type PromptChipValue =
  | { readonly kind: 'skill'; readonly name: string; readonly args?: string | undefined }
  | { readonly kind: 'mcp'; readonly id: string; readonly name: string }
  | { readonly kind: 'element'; readonly assetToken: string; readonly label: string }
  | { readonly kind: 'file'; readonly assetToken: string; readonly name: string }

type SerializedChipNode = SerializedLexicalNode & { readonly value: PromptChipValue }

export function samePromptChip(left: PromptChipValue, right: PromptChipValue): boolean {
  if (left.kind === 'skill') {
    return right.kind === 'skill' && left.name === right.name
  }
  if (left.kind === 'mcp') {
    return right.kind === 'mcp' && left.id === right.id
  }
  /* element 与 file 都以资产 token 为身份：同一份字节在一句里只该有一枚记号。 */
  return right.kind === left.kind && left.assetToken === right.assetToken
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

/* 草稿与转录共用：一句话发出去之后仍是同一枚记号，各画一遍会各漂一份。 */
export function PromptChip({ kind, name }: { readonly kind: PromptChipValue['kind']; readonly name: string }) {
  const Glyph = kind === 'mcp' ? ToolIcon : kind === 'element' ? ElementIcon : kind === 'file' ? FileDocIcon : SkillIcon

  /* title 是长名字被截断之后唯一还能读到全文的地方。 */
  return (
    <span className="assistant-prompt-chip" title={name}>
      <Glyph aria-hidden="true" className="assistant-prompt-chip__icon" />
      <span className="assistant-prompt-chip__label">{name}</span>
    </span>
  )
}

/* DecoratorNode 而不是 TextNode：屏幕上写的与交给 agent 的不是同一串。删一枚就是退格。 */
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
