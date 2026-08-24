import './prompt-chip.css'

import { integrationMarkFor, MCP_MARK } from '@poietica/ui'
import { DecoratorNode, type NodeKey, type SerializedLexicalNode } from 'lexical'
import type { ReactNode } from 'react'
import { SkillIcon } from '../primitives/icons'

export type PromptChipValue =
  | { readonly kind: 'skill'; readonly name: string; readonly args?: string | undefined }
  | { readonly kind: 'mcp'; readonly id: string; readonly name: string }

type SerializedChipNode = SerializedLexicalNode & { readonly value: PromptChipValue }

export function samePromptChip(left: PromptChipValue, right: PromptChipValue): boolean {
  return (
    left.kind === right.kind &&
    (left.kind === 'skill'
      ? left.name === (right.kind === 'skill' ? right.name : '')
      : left.id === (right.kind === 'mcp' ? right.id : ''))
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
  if (kind === 'mcp') {
    /* 那台服务器自己的标记；认不出就是 MCP 通用标记，不退回一个 @。 */
    const mark = integrationMarkFor(name) ?? MCP_MARK

    return (
      <span className="assistant-prompt-chip">
        <img
          alt=""
          className="assistant-prompt-chip__icon"
          decoding="async"
          draggable={false}
          src={mark.src}
        />
        {name}
      </span>
    )
  }

  /* 描边字形随文字走 currentColor；两枚记号的几何同归 prompt-chip.css。 */
  return (
    <span className="assistant-prompt-chip">
      <SkillIcon aria-hidden="true" className="assistant-prompt-chip__icon" />
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
    return (
      <span contentEditable={false}>
        <PromptChip kind={this.#value.kind} name={this.#value.name} />
      </span>
    )
  }
}

export function $createChipNode(value: PromptChipValue): ChipNode {
  return new ChipNode(value)
}
