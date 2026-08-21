import './prompt-chip.css'

import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { $getNodeByKey, DecoratorNode, type NodeKey, type SerializedLexicalNode } from 'lexical'
import type { ReactNode } from 'react'
import { CloseIcon, SkillIcon, ToolIcon } from '../primitives/icons'

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
    return <PromptChipView nodeKey={this.getKey()} value={this.#value} />
  }
}

function PromptChipView({
  nodeKey,
  value,
}: {
  readonly nodeKey: NodeKey
  readonly value: PromptChipValue
}) {
  const [editor] = useLexicalComposerContext()
  const Icon = value.kind === 'skill' ? SkillIcon : ToolIcon
  const label = value.kind === 'skill' ? value.name : `@${value.name}`

  return (
    <span className="assistant-prompt-chip__body" contentEditable={false}>
      <Icon aria-hidden="true" />
      <span>{label}</span>
      <button
        aria-label={`移除 ${label}`}
        className="assistant-prompt-chip__remove"
        onMouseDown={(event) => {
          event.preventDefault()
          editor.update(() => {
            const node = $getNodeByKey(nodeKey)
            if (node instanceof ChipNode) {
              node.remove()
            }
          })
        }}
        type="button"
      >
        <CloseIcon aria-hidden="true" />
      </button>
    </span>
  )
}

export function $createChipNode(value: PromptChipValue): ChipNode {
  return new ChipNode(value)
}
