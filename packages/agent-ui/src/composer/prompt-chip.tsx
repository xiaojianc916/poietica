import './prompt-chip.css'

import { DecoratorNode, type NodeKey, type SerializedLexicalNode } from 'lexical'
import type { ReactNode } from 'react'

/*
 * 正文里的一枚调用式。
 *
 * Lexical 的自定义节点范式：DecoratorNode + initialConfig.nodes 注册。它自报文本
 * （getTextContent），所以草稿的唯一真相仍是编辑器状态，提交那一路不需要认识它。
 */

type SerializedChipNode = SerializedLexicalNode & { readonly token: string }

export class ChipNode extends DecoratorNode<ReactNode> {
  readonly #token: string

  static override getType(): string {
    return 'chip'
  }

  static override clone(node: ChipNode): ChipNode {
    return new ChipNode(node.#token, node.__key)
  }

  static override importJSON(serialized: SerializedChipNode): ChipNode {
    return new ChipNode(serialized.token)
  }

  constructor(token: string, key?: NodeKey) {
    super(key)
    this.#token = token
  }

  override exportJSON(): SerializedChipNode {
    return { ...super.exportJSON(), token: this.#token }
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

  /* 提交读的是整串正文，所以这一枚必须说得出自己是什么。 */
  override getTextContent(): string {
    return this.#token
  }

  override decorate(): ReactNode {
    return this.#token
  }
}

export function $createChipNode(token: string): ChipNode {
  return new ChipNode(token)
}
