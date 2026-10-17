import { describe, expect, test } from 'bun:test'
import type { RpcMessage, WindowBridge } from '@poietica/rpc'
import { createUiKernel, defineUiFeature, KernelProvider } from '@poietica/ui-kernel'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { MotionConfig } from 'motion/react'
import { type ComposerDraft as ContributedComposerDraft, composerInputHandlers } from '../../ui-api'
import { ComposerDrafts } from '../composer/drafts'
import { ComposerDraftsContext } from '../composer/drafts-context'
import { ComposerActions } from '../composer/view/composer-actions'
import { PromptInput, PromptInputBody, PromptInputEditor, PromptInputToolbar } from '../composer/view/prompt-input'

/*
 * 粘贴的认领发生在 Lexical 插入之前（PASTE_COMMAND）：超长纯文字若先插进编辑器再抽出来，
 * 那一大段节点已经建过一遍，正是这次要避免的卡死。这里钉住两件事 ——
 * 认领的那一份一个字都不进正文、只落一枚文件记号；没认领的短句照常是文字。
 */

const PASTE_LINES = 50

function statusBridge(): WindowBridge {
  const listeners = new Set<(message: RpcMessage) => void>()
  return {
    send: (message: RpcMessage) => {
      if ('id' in message && typeof message.id === 'number' && 'method' in message) {
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

const lines = (count: number): string => Array.from({ length: count }, (_, at) => `第 ${String(at + 1)} 行`).join('\n')

async function mount(): Promise<{ container: HTMLElement; editor: HTMLElement; pasted: string[] }> {
  const pasted: string[] = []
  const host = defineUiFeature({
    id: 'test-paste-host',
    setup: (ctx) => {
      ctx.contribute(composerInputHandlers, {
        id: 'test.long-text',
        /* 同步认领：超过阈值的纯文本收成一份文件，不进正文。 */
        claims: (event) => (event.clipboardData?.getData('text/plain') ?? '').split('\n').length > PASTE_LINES,
        onPaste: async (event, draft: ContributedComposerDraft) => {
          pasted.push(event.clipboardData?.getData('text/plain') ?? '')
          draft.addAttachments([{ id: 'a1', name: '粘贴的文本.md', kind: 'file', previewUrl: null }])
          return true
        },
      })
    },
  })
  const kernel = createUiKernel({
    features: [host],
    errorMessages: {},
    validateResults: false,
    defaultRoute: { surface: 'conversation.home', params: {} },
    bridge: statusBridge(),
  })
  await kernel.start()

  const { container } = render(
    <KernelProvider kernel={kernel}>
      <MotionConfig reducedMotion="always" skipAnimations>
        <ComposerDraftsContext value={new ComposerDrafts()}>
          <PromptInput>
            <PromptInputBody>
              <PromptInputEditor placeholder="问我任何问题…" />
            </PromptInputBody>
            <PromptInputToolbar>
              <ComposerActions />
            </PromptInputToolbar>
          </PromptInput>
        </ComposerDraftsContext>
      </MotionConfig>
    </KernelProvider>,
  )
  const editor = container.querySelector<HTMLElement>('[contenteditable="true"]')
  if (editor === null) throw new Error('编辑器没有挂上')
  editor.focus()
  return { container, editor, pasted }
}

function pasteText(editor: HTMLElement, text: string): void {
  const data = new DataTransfer()
  data.setData('text/plain', text)
  fireEvent.paste(editor, { clipboardData: data })
}

describe('粘贴的认领', () => {
  test('超长文本不进正文，只落一枚文件记号', async () => {
    const { container, editor, pasted } = await mount()
    const text = lines(PASTE_LINES + 1)

    pasteText(editor, text)
    await waitFor(() => {
      expect(pasted).toHaveLength(1)
    })
    await waitFor(() => {
      expect(container.querySelector('.assistant-prompt-chip')?.getAttribute('title')).toBe('粘贴的文本.md')
    })
    /* 正文一个字都不该多出来：认领发生在 Lexical 插入之前。 */
    expect(editor.textContent).not.toContain('第 1 行')
    cleanup()
  })

  /* happy-dom 里 Lexical 的默认插入不跑（它挂在真实 beforeinput 上），所以这里钉的是「没被拦」：
     fireEvent 返回真即这件事件没有被 preventDefault，默认粘贴照旧发生。 */
  test('短句没人认领，不拦这一下粘贴', async () => {
    const { editor, pasted } = await mount()
    const data = new DataTransfer()
    data.setData('text/plain', '就一句话')

    expect(fireEvent.paste(editor, { clipboardData: data })).toBe(true)
    expect(pasted).toHaveLength(0)
    cleanup()
  })
})
