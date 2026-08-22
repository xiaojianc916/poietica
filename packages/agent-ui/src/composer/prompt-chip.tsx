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
    return <PromptChipView value={this.#value} />
  }
}

function PromptChipView({ value }: { readonly value: PromptChipValue }) {
  const label = value.kind === 'skill' ? value.name : `@${value.name}`

  return (
    <span className="assistant-prompt-chip__body" contentEditable={false}>
      {value.kind === 'skill' ? <SkillIcon aria-hidden="true" /> : null}
      <span>{label}</span>
    </span>
  )
}

export function $createChipNode(value: PromptChipValue): ChipNode {
  return new ChipNode(value)
}
