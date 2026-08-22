import './prompt-chip.css'

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
    return new ChipNode(serialized.value)
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
    const span = document.createElement('span')
    span.className = 'assistant-prompt-chip'
    return span
  }

  override updateDOM(): false {
    return false
  }

  override isInline(): true {
    return true
  }

  override getTextContent(): string {
    return this.#value.kind === 'mcp' ? `@mcp:${this.#value.name}` : ''
  }

  override decorate(): ReactNode {
    if (this.#value.kind === 'skill') {
      /* 图标随文字走 currentColor（prompt-chip.css 的 #2563eb），不另立颜色。 */
      return (
        <span contentEditable={false}>
          <SkillIcon aria-hidden="true" className="assistant-prompt-chip__icon" size={12} />
          {this.#value.name}
        </span>
      )
    }

    return <span contentEditable={false}>@{this.#value.name}</span>
  }
}

export function $createChipNode(value: PromptChipValue): ChipNode {
  return new ChipNode(value)
}
