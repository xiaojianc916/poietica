import { DecoratorNode, type DOMExportOutput, type LexicalNode, type NodeKey } from 'lexical'
import type { ReactNode } from 'react'
import { SkillIcon } from '../primitives/icons'

/*
 * 一次技能调用，在草稿里就是一个字。
 *
 * 屏幕上是图标加标题，getTextContent 交出的是调用式 —— 于是"看见的"与"送出去的"
 * 由同一个节点定义，不需要第二份状态去对齐。原子性归 Lexical：整枚选中、整枚删除。
 */

export interface SerializedSkillNode {
  readonly type: 'skill'
  readonly version: 1
  readonly call: string
  readonly title: string
}

export class SkillNode extends DecoratorNode<ReactNode> {
  readonly __call: string

  readonly __title: string

  constructor(call: string, title: string, key?: NodeKey) {
    super(key)
    this.__call = call
    this.__title = title
  }

  static getType(): string {
    return 'skill'
  }

  static clone(node: SkillNode): SkillNode {
    return new SkillNode(node.__call, node.__title, node.__key)
  }

  static importJSON(serialized: SerializedSkillNode): SkillNode {
    return new SkillNode(serialized.call, serialized.title)
  }

  exportJSON(): SerializedSkillNode {
    return { type: 'skill', version: 1, call: this.__call, title: this.__title }
  }

  createDOM(): HTMLElement {
    const span = document.createElement('span')

    span.className = 'composer-skill'

    return span
  }

  updateDOM(): false {
    return false
  }

  exportDOM(): DOMExportOutput {
    const element = document.createElement('span')

    element.textContent = this.__call

    return { element }
  }

  isInline(): true {
    return true
  }

  isKeyboardSelectable(): true {
    return true
  }

  /** 送出去的字节。屏幕上的标题不参与。 */
  getTextContent(): string {
    return this.__call
  }

  decorate(): ReactNode {
    return (
      <>
        <SkillIcon aria-hidden="true" />

        <span>{this.__title}</span>
      </>
    )
  }
}

export function $createSkillNode(call: string, title: string): SkillNode {
  return new SkillNode(call, title)
}

export function $isSkillNode(node: LexicalNode | null | undefined): node is SkillNode {
  return node instanceof SkillNode
}
