import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isParagraphNode,
  $nodesOfType,
  createEditor,
  type LexicalEditor,
  type SerializedEditorState,
} from 'lexical'
import type { PromptSkill } from '../shared/model/session'
import { ChipNode, type PromptChipValue } from '../shared/primitives/prompt-chip'

/*
 * 草稿文档的全部读写口。持久化的是 Lexical 的 SerializedEditorState，不是扁平文本：
 * 技能 chip、正文里文件 / 元素记号的位置、附件配置都在这棵树里。store 只存这一份，
 * 屏幕上的编辑器是它的一个视图。
 */

export type InlineChip = Extract<PromptChipValue, { kind: 'element' | 'file' }>

export interface DraftProjection {
  readonly text: string
  readonly skills: readonly PromptSkill[]
  readonly inline: readonly InlineChip[]
}

/** 纯读：进 editorState.read，不许有副作用。 */
export function readDraftProjection(): DraftProjection {
  const skills = new Map<string, PromptSkill>()
  const inline: InlineChip[] = []

  for (const node of $nodesOfType(ChipNode)) {
    const value = node.value()
    if (value.kind === 'skill') {
      skills.set(value.name, {
        name: value.name,
        ...(value.args === undefined ? {} : { args: value.args }),
      })
    } else if (value.kind === 'element' || value.kind === 'file') {
      inline.push(value)
    }
  }

  return { text: $getRoot().getTextContent(), skills: [...skills.values()], inline }
}

function editorOf(document: SerializedEditorState | undefined): LexicalEditor {
  const editor = createEditor({
    namespace: 'composer-draft',
    nodes: [ChipNode],
    theme: {},
    onError: (error: Error) => {
      throw error
    },
  })

  if (document !== undefined) {
    try {
      editor.setEditorState(editor.parseEditorState(JSON.stringify(document)))
    } catch {
      /* 旧版本 / 认不出的节点：这份文档不可信，按空草稿处理，不把输入框卡死。 */
    }
  }

  return editor
}

/** 一份只有正文的文档；给 store 的 setText（测试与未挂载路径）用。 */
export function textDocument(text: string): SerializedEditorState {
  const editor = editorOf(undefined)
  editor.update(
    () => {
      const root = $getRoot()
      const paragraph = $createParagraphNode()

      root.clear()
      if (text !== '') paragraph.append($createTextNode(text))
      root.append(paragraph)
    },
    { discrete: true },
  )
  return editor.getEditorState().toJSON()
}

/** 往文档末尾追加一句；未挂载的 composerOf().insertText 走这里。 */
export function appendText(document: SerializedEditorState | undefined, text: string): SerializedEditorState {
  const editor = editorOf(document)
  editor.update(
    () => {
      const root = $getRoot()
      const last = root.getLastChild()
      const paragraph = $isParagraphNode(last) ? last : $createParagraphNode()
      if (!paragraph.getParent()) root.append(paragraph)
      const separator = paragraph.getTextContent() === '' ? '' : ' '
      paragraph.append($createTextNode(`${separator}${text}`))
    },
    { discrete: true },
  )
  return editor.getEditorState().toJSON()
}

export function projectDocument(document: SerializedEditorState | undefined): DraftProjection {
  return editorOf(document).getEditorState().read(readDraftProjection)
}
