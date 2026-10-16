import { describe, expect, test } from 'bun:test'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import type { RpcMessage, WindowBridge } from '@poietica/rpc'
import { createUiKernel, defineUiFeature, KernelProvider } from '@poietica/ui-kernel'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { $getRoot, type LexicalEditor, REDO_COMMAND, UNDO_COMMAND } from 'lexical'
import { MotionConfig } from 'motion/react'
import { type ReactNode, useEffect, useRef } from 'react'
import { composerToolkitSources } from '../../ui-api'
import { ComposerDrafts } from '../composer/drafts'
import { ComposerDraftsContext } from '../composer/drafts-context'
import type { PromptInputMessage } from '../composer/prompt'
import { ComposerActions, composerPaletteGroups } from '../composer/view/composer-actions'
import {
  PromptInput,
  PromptInputBody,
  PromptInputEditor,
  type PromptInputHandle,
  PromptInputToolbar,
} from '../composer/view/prompt-input'

/*
 * 输入框的撤销（Ctrl+Z）。
 *
 * v1 的缺口：`PromptInput` 没挂 `HistoryPlugin`，而 Lexical 内核会把 Ctrl+Z 拦成 UNDO_COMMAND
 * 并 preventDefault（`Lexical.dev.js` 的 keydown 表与 `historyUndo` 分支），于是原生撤销与命令
 * 两头都落空 —— 这个键死着。这里钉三件事：
 *   1. 撤销真的接上了（v1 上 `dispatchCommand(UNDO_COMMAND)` 返回 false）；
 *   2. 打字后撤销退回上一步；
 *   3. 提交后的清空不可撤销 —— 否则「发送后 Ctrl+Z」能把正文捞回来，再回车就是一次静默重发。
 */

function statusBridge(): WindowBridge {
  const listeners = new Set<(message: RpcMessage) => void>()

  return {
    send: (message: RpcMessage) => {
      if (
        'id' in message &&
        typeof message.id === 'number' &&
        'method' in message &&
        message.method === 'core.getStatus'
      ) {
        const id = message.id

        queueMicrotask(() => {
          for (const listener of [...listeners]) {
            listener({ jsonrpc: '2.0', id, result: { state: 'ready', reason: null, attempt: 0 } })
          }
        })
      }
    },
    onMessage: (listener: (message: RpcMessage) => void) => {
      listeners.add(listener)

      return () => {
        listeners.delete(listener)
      }
    },
    pathForFile: () => 'C:/tmp/x',
  } satisfies WindowBridge
}

/** 从工具栏那一格抓编辑器实例：撤销要直接派命令，happy-dom 的键盘事件到不了 Lexical 的 keydown 表。 */
function EditorProbe({ onEditor }: { readonly onEditor: (editor: LexicalEditor) => void }): ReactNode {
  const [editor] = useLexicalComposerContext()

  useEffect(() => {
    onEditor(editor)
  }, [editor, onEditor])

  return <PromptInputToolbar />
}

interface Harnessed {
  readonly container: HTMLElement
  readonly handle: () => PromptInputHandle | null
  readonly editor: () => LexicalEditor
  readonly text: () => string
}

async function harness(): Promise<{
  readonly renderComposer: (onSubmit?: (message: PromptInputMessage) => void) => Harnessed
  readonly unmount: () => void
}> {
  const provider = defineUiFeature({
    id: 'test-provider',
    setup: (ctx) => {
      ctx.contribute(composerToolkitSources, {
        id: 'test.source',
        ensure: () => undefined,
        read: () => ({ skills: [{ name: '翻译', description: '翻一下', source: 'user' }], mcpServers: [] }),
        subscribe: () => () => undefined,
      })
    },
  })
  const kernel = createUiKernel({
    features: [provider],
    errorMessages: {},
    validateResults: false,
    defaultRoute: { surface: 'conversation.home', params: {} },
    bridge: statusBridge(),
  })
  await kernel.start()

  const drafts = new ComposerDrafts()
  const containers: HTMLElement[] = []

  return {
    renderComposer: (onSubmit) => {
      let handle: PromptInputHandle | null = null
      let editor: LexicalEditor | null = null

      function Composer(): ReactNode {
        const ref = useRef<PromptInputHandle | null>(null)
        const groups = composerPaletteGroups({
          controls: [],
          mcpServers: [],
          onSelectControl: () => undefined,
          skills: [{ name: '翻译', description: '翻一下', source: 'user' }],
        })

        return (
          <KernelProvider kernel={kernel}>
            <MotionConfig reducedMotion="always" skipAnimations>
              <ComposerDraftsContext value={drafts}>
                <PromptInput
                  groups={groups}
                  onSubmit={onSubmit}
                  ref={(next) => {
                    ref.current = next
                    handle = next
                  }}
                >
                  <PromptInputBody>
                    <PromptInputEditor placeholder="问我任何问题…" />
                  </PromptInputBody>
                  <EditorProbe
                    onEditor={(next) => {
                      editor = next
                    }}
                  />
                  <ComposerActions />
                </PromptInput>
              </ComposerDraftsContext>
            </MotionConfig>
          </KernelProvider>
        )
      }

      const { container } = render(<Composer />)
      containers.push(container)

      const read = (): string => {
        const current = editor

        return current === null ? '' : current.getEditorState().read(() => $getRoot().getTextContent())
      }

      return {
        container,
        handle: () => handle,
        editor: () => editor as LexicalEditor,
        text: read,
      }
    },
    unmount: () => {
      cleanup()
      containers.length = 0
    },
  }
}

describe('输入框的撤销', () => {
  /*
   * 必须写两次：HistoryPlugin 在自己的 useEffect 里注册监听，而 LexicalComposer 的初始化更新
   * 发生在它之前的渲染期，所以历史状态此刻还是 null —— Lexical 的既定语义是「编辑器的第一次更新
   * 不可撤销」（`getUndoEntry` 在 current 为 null 时返回 null）。第一次改动因此不进撤销栈。
   */
  test('撤销接上了：再改一次后退回上一步，重做能再做回来', async () => {
    const harnessed = await harness()

    try {
      const view = harnessed.renderComposer(() => undefined)

      await waitFor(() => {
        expect(view.editor()).not.toBeNull()
      })

      view.handle()?.setText('第一版')

      await waitFor(() => {
        expect(view.text()).toBe('第一版')
      })

      view.handle()?.setText('第二版')

      await waitFor(() => {
        expect(view.text()).toBe('第二版')
      })

      /* 内核把 Ctrl+Z 派成这个命令；v1 没人接，返回 false。 */
      expect(view.editor().dispatchCommand(UNDO_COMMAND, undefined)).toBe(true)

      await waitFor(() => {
        expect(view.text()).toBe('第一版')
      })

      expect(view.editor().dispatchCommand(REDO_COMMAND, undefined)).toBe(true)

      await waitFor(() => {
        expect(view.text()).toBe('第二版')
      })
    } finally {
      await Bun.sleep(400)
      harnessed.unmount()
    }
  })

  test('提交后的清空不可撤销：撤销捞不回已发出的正文', async () => {
    const harnessed = await harness()

    try {
      const view = harnessed.renderComposer(() => undefined)

      await waitFor(() => {
        expect(view.editor()).not.toBeNull()
      })

      /* 先垫一次改动，让撤销栈里确实有东西可退 —— 否则这条用例会因为「第一次更新不可撤销」而空过。 */
      view.handle()?.setText('先垫一句')

      await waitFor(() => {
        expect(view.text()).toBe('先垫一句')
      })

      view.handle()?.setText('这句要发出去')

      await waitFor(() => {
        expect(view.text()).toBe('这句要发出去')
      })

      const form = view.container.querySelector('form')

      expect(form).not.toBeNull()
      fireEvent.submit(form!)

      await waitFor(() => {
        expect(view.text()).toBe('')
      })

      /* 历史被清过：再按撤销不该把刚发出去的正文捞回来。 */
      view.editor().dispatchCommand(UNDO_COMMAND, undefined)

      await Bun.sleep(50)

      expect(view.text()).toBe('')
    } finally {
      await Bun.sleep(400)
      harnessed.unmount()
    }
  })
})
